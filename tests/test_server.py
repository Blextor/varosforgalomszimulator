"""HTTP regression tests for Windows-safe error handling."""

from __future__ import annotations

import gzip
import http.client
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import Mock, call, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import (
    ApplicationHandler,
    COMPACT_STATE_VERSION,
    MAX_REQUEST_BYTES,
    RUNTIME,
    RobustThreadingHTTPServer,
    SimulationRuntime,
    _run_supervised_child,
    parse_arguments,
)


class CompactSimulationStub:
    route_catalog_loaded = True
    route_selection_stats = {
        "car": {"viableAnchors": 2},
        "pedestrian": {"viableAnchors": 3},
    }

    def __init__(self) -> None:
        self.records = {
            1: (0, 474_000_000, 190_000_000, 900, 0, 0),
            2: (1, 474_000_100, 190_000_100, 450, 0, 0),
            3: (0, 474_000_200, 190_000_200, 1800, 1, 0),
        }

    def compact_agent_records(self) -> dict[int, tuple[int, ...]]:
        return dict(self.records)

    def compact_selected_agent(self, agent_id: int) -> tuple[object, ...] | None:
        if agent_id not in self.records:
            return None
        return (
            agent_id,
            ("origin", "Indulás", "shopping", "poi", 15),
            ("destination", "Érkezés", "transit", "gateway", 0),
        )

    def selected_route_snapshot(
        self, agent_id: int, known_route_token: str | None
    ) -> dict[str, object] | None:
        if agent_id not in self.records:
            return None
        route = {"agentId": agent_id, "mode": "car", "token": "route", "routeIndex": 2}
        if known_route_token != "route":
            route["nodeIds"] = [1, 2, 3]
        return route

    def stats(self) -> dict[str, int]:
        return {"cars": 2, "pedestrians": 1, "completedTrips": 4}


class ServerErrorHandlingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = RobustThreadingHTTPServer(
            ("127.0.0.1", 0), ApplicationHandler
        )
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        RUNTIME.close()

    def test_import_keeps_lazy_runtime_uninitialized(self) -> None:
        environment = os.environ.copy()
        environment["PYTHONMALLOC"] = "malloc"
        environment["UJBUDA_SAFE_RUNTIME"] = "0"
        repository_root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import server; "
                    "print(server.RUNTIME.is_initialized())"
                ),
            ],
            cwd=repository_root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "False")

    def test_favicon_is_a_clean_empty_response(self) -> None:
        with urlopen(f"{self.base_url}/favicon.ico", timeout=5) as response:
            self.assertEqual(response.status, 204)
            self.assertIsNone(response.getheader("Content-Length"))
            self.assertEqual(response.read(), b"")

    def test_simulation_timing_module_is_served(self) -> None:
        with urlopen(
            f"{self.base_url}/src/simulation-timing.js", timeout=5
        ) as response:
            content = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("javascript", response.getheader("Content-Type"))
            self.assertIn("RUNNING_POLL_INTERVAL_MS = 125", content)

    def test_static_map_worker_is_served(self) -> None:
        with urlopen(
            f"{self.base_url}/src/static-map-worker.js", timeout=5
        ) as response:
            content = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("javascript", response.getheader("Content-Type"))
            self.assertIn("renderStaticMap", content)

    def test_replay_buffer_module_is_served(self) -> None:
        with urlopen(
            f"{self.base_url}/src/replay-buffer.js", timeout=5
        ) as response:
            content = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("javascript", response.getheader("Content-Type"))
            self.assertIn("REPLAY_WINDOW_MS = 60_000", content)

    def test_segment_statistics_endpoint_keeps_metrics_out_of_state_stream(self) -> None:
        payload = {
            "configured": True,
            "windowSeconds": 60.0,
            "elapsedSeconds": 12.5,
            "segments": {"segment-a": [7, 2, 31.4, 0.63, 37.0, 18.0]},
        }
        with patch.object(
            RUNTIME, "segment_statistics", return_value=payload
        ) as statistics:
            with urlopen(
                f"{self.base_url}/api/simulation/segments?includeSegmentId=segment-a",
                timeout=5,
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read().decode("utf-8")), payload)
        statistics.assert_called_once_with(
            segment_id=None,
            include_segment_id="segment-a",
        )

    def test_segment_statistics_endpoint_rejects_ambiguous_query(self) -> None:
        with patch.object(RUNTIME, "segment_statistics") as statistics:
            with self.assertRaises(HTTPError) as captured:
                urlopen(
                    f"{self.base_url}/api/simulation/segments?segmentId=a&includeSegmentId=b",
                    timeout=5,
                )
            self.assertEqual(captured.exception.code, 400)
            captured.exception.read()
        statistics.assert_not_called()

    def test_reset_control_response_identifies_the_new_simulation_epoch(self) -> None:
        class FakeSimulation:
            reset_calls = 0

            def reset(self) -> None:
                self.reset_calls += 1

            def snapshot(self) -> dict[str, object]:
                return {"agents": [{"id": 1}], "stats": {"cars": 1}}

        runtime = SimulationRuntime.__new__(SimulationRuntime)
        runtime.lock = threading.RLock()
        runtime.simulation = FakeSimulation()
        runtime.network_error = None
        runtime.running = True
        runtime.speed_multiplier = 15.0
        runtime.instance_id = "server-test"
        runtime.simulation_epoch = 4
        runtime.compact_clients = {"active-client": {"revision": 8}}

        response = runtime.control("reset")

        self.assertFalse(response["running"])
        self.assertTrue(response["configured"])
        self.assertEqual(response["serverInstanceId"], "server-test")
        self.assertEqual(response["simulationEpoch"], 5)
        self.assertEqual(response["speedMultiplier"], 15.0)
        self.assertEqual(response["agents"], [{"id": 1}])
        self.assertEqual(runtime.simulation.reset_calls, 1)
        self.assertEqual(runtime.compact_clients, {})

    def test_http_11_connection_is_reused_for_polling(self) -> None:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=5
        )
        try:
            connection.request("GET", "/api/health")
            first_response = connection.getresponse()
            self.assertEqual(first_response.version, 11)
            self.assertFalse(first_response.will_close)
            first_response.read()
            first_socket = connection.sock
            self.assertIsNotNone(first_socket)

            connection.request("GET", "/api/simulation/state")
            second_response = connection.getresponse()
            self.assertEqual(second_response.status, 200)
            second_response.read()
            self.assertIs(connection.sock, first_socket)
        finally:
            connection.close()

    def test_simulation_state_forwards_selected_agent_and_route_token(self) -> None:
        response_payload = {
            "configured": True,
            "running": False,
            "agents": [],
            "selectedRoute": None,
        }
        with patch.object(
            RUNTIME, "snapshot", return_value=response_payload
        ) as snapshot:
            with urlopen(
                (
                    f"{self.base_url}/api/simulation/state"
                    "?selectedAgentId=37&knownRouteToken=route-token_123"
                ),
                timeout=5,
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    json.loads(response.read().decode("utf-8")),
                    response_payload,
                )

        snapshot.assert_called_once_with(
            selected_agent_id=37,
            known_route_token="route-token_123",
        )

    def test_simulation_state_accepts_selected_agent_without_route_token(self) -> None:
        with patch.object(
            RUNTIME,
            "snapshot",
            return_value={"configured": True, "running": False, "agents": []},
        ) as snapshot:
            with urlopen(
                f"{self.base_url}/api/simulation/state?selectedAgentId=11",
                timeout=5,
            ) as response:
                self.assertEqual(response.status, 200)
                response.read()

        snapshot.assert_called_once_with(
            selected_agent_id=11,
            known_route_token=None,
        )

    def test_compact_state_query_forwards_revision_and_selection(self) -> None:
        response_payload = {
            "v": COMPACT_STATE_VERSION,
            "k": "d",
            "b": 8,
            "r": 9,
            "c": True,
            "a": [],
        }
        with patch.object(
            RUNTIME, "snapshot_compact", return_value=response_payload
        ) as snapshot:
            with urlopen(
                (
                    f"{self.base_url}/api/simulation/state?protocol=2"
                    "&clientId=browser-client-1&baseRevision=8"
                    "&selectedAgentId=37&knownRouteToken=route-token"
                ),
                timeout=5,
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    json.loads(response.read().decode("utf-8")), response_payload
                )

        snapshot.assert_called_once_with(
            client_id="browser-client-1",
            base_revision=8,
            selected_agent_id=37,
            known_route_token="route-token",
        )

    def test_compact_runtime_emits_delta_and_resyncs_after_missed_response(self) -> None:
        runtime = SimulationRuntime.__new__(SimulationRuntime)
        runtime.lock = threading.RLock()
        runtime.simulation = CompactSimulationStub()
        runtime.running = True
        runtime.speed_multiplier = 15.0
        runtime.instance_id = "instance"
        runtime.simulation_epoch = 1
        runtime.compact_clients = {}

        full = runtime.snapshot_compact("browser-client", selected_agent_id=1)
        self.assertEqual((full["v"], full["k"], full["r"]), (2, "f", 1))
        self.assertEqual(len(full["a"]), 3)
        self.assertTrue(all(len(row) == 6 for row in full["a"]))
        self.assertEqual(full["t"], [1, 2, 3])
        self.assertEqual(full["z"][0], 1)
        self.assertEqual(full["q"]["nodeIds"], [1, 2, 3])

        runtime.simulation.records = {
            1: (0, 474_000_010, 190_000_010, 900, 0, 0),
            2: (1, 474_000_110, 190_000_110, 500, 1, 1),
            4: (1, 474_000_300, 190_000_300, 2700, 0, 0),
        }
        delta = runtime.snapshot_compact(
            "browser-client",
            base_revision=full["r"],
            selected_agent_id=1,
            known_route_token="route",
        )
        self.assertEqual((delta["k"], delta["b"], delta["r"]), ("d", 1, 2))
        self.assertEqual(delta["p"], [(1, 474_000_010, 190_000_010)])
        self.assertEqual(delta["u"], [(2, 474_000_110, 190_000_110, 500, 1)])
        self.assertEqual(delta["n"], [(4, 1, 474_000_300, 190_000_300, 2700, 0)])
        self.assertEqual(delta["x"], [3])
        self.assertEqual(delta["t"], [2])
        self.assertTrue(all(len(row) == 5 for row in delta["u"]))
        self.assertTrue(all(len(row) == 6 for row in delta["n"]))
        self.assertNotIn("nodeIds", delta["q"])

        runtime.simulation.records[4] = (
            *runtime.simulation.records[4][:5],
            1,
        )
        relocation_only = runtime.snapshot_compact(
            "browser-client", base_revision=delta["r"]
        )
        self.assertEqual(relocation_only["t"], [4])
        for field in ("p", "u", "n", "x"):
            self.assertNotIn(field, relocation_only)

        steady = runtime.snapshot_compact(
            "browser-client", base_revision=relocation_only["r"]
        )
        self.assertNotIn("t", steady)

        resync = runtime.snapshot_compact(
            "browser-client", base_revision=full["r"]
        )
        self.assertEqual(resync["k"], "f")
        self.assertEqual(resync["r"], 5)
        self.assertEqual(len(resync["a"]), 3)
        self.assertEqual(resync["t"], [1, 2, 4])

        runtime._clear_compact_clients()
        runtime._advance_simulation_epoch()
        next_epoch = runtime.snapshot_compact(
            "browser-client", base_revision=resync["r"]
        )
        self.assertEqual(next_epoch["k"], "f")
        self.assertEqual(next_epoch["r"], 1)
        self.assertEqual(next_epoch["epoch"], 2)
        self.assertEqual(next_epoch["t"], [1, 2, 4])

    def test_compact_runtime_accepts_legacy_five_value_internal_records(self) -> None:
        runtime = SimulationRuntime.__new__(SimulationRuntime)
        runtime.lock = threading.RLock()
        runtime.simulation = CompactSimulationStub()
        runtime.simulation.records = {
            1: (0, 474_000_000, 190_000_000, 900, 0),
        }
        runtime.running = False
        runtime.speed_multiplier = 15.0
        runtime.instance_id = "instance"
        runtime.simulation_epoch = 1
        runtime.compact_clients = {}

        full = runtime.snapshot_compact("legacy-record-client")

        self.assertEqual(full["a"], [(1, 0, 474_000_000, 190_000_000, 900, 0)])
        self.assertEqual(full["t"], [1])
        self.assertEqual(
            runtime.compact_clients["legacy-record-client"]["agents"][1],
            (0, 474_000_000, 190_000_000, 900, 0, 0),
        )

    def test_json_response_negotiates_fast_gzip_without_changing_payload(self) -> None:
        response_payload = {
            "v": 2,
            "k": "f",
            "r": 1,
            "c": True,
            "a": [[index, 0, 474_000_000 + index, 190_000_000, 900, 0] for index in range(1, 300)],
        }
        path = "/api/simulation/state?protocol=2&clientId=gzip-client"
        with patch.object(RUNTIME, "snapshot_compact", return_value=response_payload):
            connection = http.client.HTTPConnection(
                "127.0.0.1", self.server.server_port, timeout=5
            )
            try:
                connection.request("GET", path, headers={"Accept-Encoding": "gzip"})
                compressed_response = connection.getresponse()
                compressed_body = compressed_response.read()
                self.assertEqual(compressed_response.getheader("Content-Encoding"), "gzip")
                self.assertEqual(compressed_response.getheader("Vary"), "Accept-Encoding")
                self.assertEqual(
                    int(compressed_response.getheader("Content-Length")),
                    len(compressed_body),
                )
                decoded_compressed = json.loads(gzip.decompress(compressed_body))

                connection.request("GET", path, headers={"Accept-Encoding": "gzip;q=0"})
                plain_response = connection.getresponse()
                plain_body = plain_response.read()
                self.assertIsNone(plain_response.getheader("Content-Encoding"))
                decoded_plain = json.loads(plain_body)
            finally:
                connection.close()

        self.assertEqual(decoded_compressed, response_payload)
        self.assertEqual(decoded_plain, response_payload)
        self.assertLess(len(compressed_body), len(plain_body))

    def test_compact_client_overflow_does_not_evict_active_delta_caches(self) -> None:
        runtime = SimulationRuntime.__new__(SimulationRuntime)
        runtime.lock = threading.RLock()
        runtime.simulation = CompactSimulationStub()
        runtime.running = False
        runtime.speed_multiplier = 15.0
        runtime.instance_id = "instance"
        runtime.simulation_epoch = 1
        runtime.compact_clients = {}

        for index in range(16):
            runtime.snapshot_compact(f"active-client-{index}")
        first_overflow = runtime.snapshot_compact("overflow-client")
        second_overflow = runtime.snapshot_compact(
            "overflow-client", base_revision=first_overflow["r"]
        )

        self.assertEqual(len(runtime.compact_clients), 16)
        self.assertIn("active-client-0", runtime.compact_clients)
        self.assertNotIn("overflow-client", runtime.compact_clients)
        self.assertEqual(first_overflow["k"], "f")
        self.assertEqual(second_overflow["k"], "f")

    def test_simulation_state_rejects_invalid_or_repeated_selected_agent(self) -> None:
        invalid_queries = (
            "selectedAgentId=",
            "selectedAgentId=not-an-integer",
            "selectedAgentId=1.5",
            "selectedAgentId=0",
            "selectedAgentId=-7",
            "selectedAgentId=3&selectedAgentId=3",
        )
        for query in invalid_queries:
            with self.subTest(query=query):
                with patch.object(RUNTIME, "snapshot") as snapshot:
                    with self.assertRaises(HTTPError) as captured:
                        urlopen(
                            f"{self.base_url}/api/simulation/state?{query}",
                            timeout=5,
                        )
                    error = captured.exception
                    self.assertEqual(error.code, 400)
                    payload = json.loads(error.read().decode("utf-8"))
                    self.assertTrue(payload["error"])
                    snapshot.assert_not_called()

    def test_simulation_state_rejects_invalid_compact_protocol_parameters(self) -> None:
        invalid_queries = (
            "protocol=2",
            "protocol=2&clientId=short",
            "protocol=2&clientId=valid-client&baseRevision=-1",
            "protocol=2&clientId=valid-client&baseRevision=bad",
            "protocol=3&clientId=valid-client",
            "clientId=valid-client",
            "protocol=2&protocol=2&clientId=valid-client",
        )
        for query in invalid_queries:
            with self.subTest(query=query):
                with patch.object(RUNTIME, "snapshot_compact") as compact_snapshot:
                    with self.assertRaises(HTTPError) as captured:
                        urlopen(
                            f"{self.base_url}/api/simulation/state?{query}",
                            timeout=5,
                        )
                    self.assertEqual(captured.exception.code, 400)
                    captured.exception.read()
                    compact_snapshot.assert_not_called()

    def test_conditional_network_response_is_complete_for_keep_alive(self) -> None:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=10
        )
        try:
            connection.request("GET", "/api/network")
            first_response = connection.getresponse()
            self.assertEqual(first_response.status, 200)
            etag = first_response.getheader("ETag")
            self.assertTrue(etag)
            network_payload = json.loads(
                gzip.decompress(first_response.read()).decode("utf-8")
            )
            self.assertGreater(len(network_payload["nodes"]), 50_000)
            self.assertGreater(len(network_payload["segments"]), 50_000)
            self.assertTrue(network_payload["segments"][0]["modes"])

            connection.request("GET", "/api/network", headers={"If-None-Match": etag})
            cached_response = connection.getresponse()
            self.assertEqual(cached_response.status, 304)
            self.assertIsNone(cached_response.getheader("Content-Length"))
            self.assertEqual(
                cached_response.getheader("Cache-Control"), "private, no-cache"
            )
            self.assertEqual(cached_response.read(), b"")

            connection.request("GET", "/api/health")
            health_response = connection.getresponse()
            self.assertEqual(health_response.status, 200)
            health_response.read()
        finally:
            connection.close()

    def test_second_server_cannot_share_the_same_port(self) -> None:
        with self.assertRaises(OSError):
            RobustThreadingHTTPServer(
                ("127.0.0.1", self.server.server_port), ApplicationHandler
            )

    def test_utf8_not_found_does_not_kill_server(self) -> None:
        with self.assertRaises(HTTPError) as captured:
            urlopen(f"{self.base_url}/nem-letezik", timeout=5)
        error = captured.exception
        self.assertEqual(error.code, 404)
        self.assertIn("Az erőforrás nem található", error.read().decode("utf-8"))

        with urlopen(f"{self.base_url}/api/health", timeout=5) as response:
            health = json.loads(response.read().decode("utf-8"))
        self.assertTrue(health["networkLoaded"])

    def test_unknown_api_endpoint_returns_utf8_json(self) -> None:
        request = Request(
            f"{self.base_url}/api/nem-letezik",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(HTTPError) as captured:
            urlopen(request, timeout=5)
        error = captured.exception
        payload = json.loads(error.read().decode("utf-8"))
        self.assertEqual(error.code, 404)
        self.assertEqual(payload["error"], "Az API-végpont nem található.")

    def test_aborted_request_does_not_log_traceback_or_stop_server(self) -> None:
        captured_stderr = io.StringIO()
        with patch("server.get_runtime") as get_runtime, redirect_stderr(
            captured_stderr
        ):
            get_runtime.return_value.health.return_value = {
                "status": "ok",
                "networkLoaded": True,
            }
            connection = socket.create_connection(
                ("127.0.0.1", self.server.server_port), timeout=5
            )
            connection.sendall(
                b"POST /api/simulation/configure HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Length: 1000\r\n\r\n{"
            )
            connection.close()

            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    with urlopen(f"{self.base_url}/api/health", timeout=1) as response:
                        self.assertEqual(response.status, 200)
                    break
                except OSError:
                    time.sleep(0.02)
            else:
                self.fail("A szerver nem válaszolt a megszakított kérés után.")
            time.sleep(0.05)
        self.assertNotIn("Traceback", captured_stderr.getvalue())

    def test_oversized_post_closes_keep_alive_before_unread_body(self) -> None:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=5
        )
        try:
            connection.request(
                "POST",
                "/api/simulation/configure",
                body=b"{" + b" " * MAX_REQUEST_BYTES,
                headers={"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(response.getheader("Connection"), "close")
            self.assertTrue(response.will_close)
            response.read()
        finally:
            connection.close()

    def test_parallel_identical_configuration_is_built_only_once(self) -> None:
        class FakeSimulation:
            constructions = 0

            def __init__(
                self, network: object, *, cars: int, pedestrians: int, seed: int
            ) -> None:
                del network
                type(self).constructions += 1
                time.sleep(0.02)
                self.seed = seed
                self.route_selection_stats = {
                    "car": {"viableAnchors": 1},
                    "pedestrian": {"viableAnchors": 1},
                }
                self._stats = {"cars": cars, "pedestrians": pedestrians}

            def stats(self) -> dict[str, int]:
                return dict(self._stats)

        runtime = SimulationRuntime.__new__(SimulationRuntime)
        runtime.lock = threading.RLock()
        runtime.network = object()
        runtime.network_error = None
        runtime.simulation = None
        runtime.configuration = None
        runtime.running = False
        runtime.speed_multiplier = 15.0
        runtime.ensure_network = lambda: runtime.network
        payload = {"cars": 400, "pedestrians": 600, "seed": 123}

        with patch("server.NetworkTrafficSimulation", FakeSimulation):
            with ThreadPoolExecutor(max_workers=4) as pool:
                responses = list(pool.map(lambda _: runtime.configure(payload), range(4)))
            self.assertEqual(FakeSimulation.constructions, 1)
            self.assertEqual(sum(not response["reused"] for response in responses), 1)
            self.assertEqual(sum(response["reused"] for response in responses), 3)
            self.assertTrue(all(response["simulationEpoch"] == 1 for response in responses))

            runtime.running = True
            repeated = runtime.configure(payload)
            self.assertTrue(repeated["reused"])
            self.assertTrue(repeated["running"])
            self.assertEqual(repeated["speedMultiplier"], 15.0)
            self.assertEqual(repeated["simulationEpoch"], 1)
            self.assertEqual(FakeSimulation.constructions, 1)

            changed = runtime.configure({**payload, "cars": 401})
            self.assertFalse(changed["reused"])
            self.assertFalse(changed["running"])
            self.assertFalse(runtime.running)
            self.assertEqual(FakeSimulation.constructions, 2)
            self.assertEqual(changed["simulationEpoch"], 2)

    def test_partial_settings_preserve_values_changed_by_another_tab(self) -> None:
        class FakeSimulation:
            seed = 123

            def __init__(self) -> None:
                self.cars = 500
                self.pedestrians = 600

            def stats(self) -> dict[str, int]:
                return {"cars": self.cars, "pedestrians": self.pedestrians}

            def set_agent_targets(self, *, cars: int, pedestrians: int) -> None:
                self.cars = cars
                self.pedestrians = pedestrians

        runtime = SimulationRuntime.__new__(SimulationRuntime)
        runtime.lock = threading.RLock()
        runtime.simulation = FakeSimulation()
        runtime.network_error = None
        runtime.running = False
        runtime.speed_multiplier = 15.0

        speed_only = runtime.update_settings({"speedMultiplier": 30})
        self.assertEqual(speed_only["stats"], {"cars": 500, "pedestrians": 600})
        self.assertEqual(runtime.speed_multiplier, 30)

        cars_only = runtime.update_settings({"cars": 550})
        self.assertEqual(cars_only["stats"], {"cars": 550, "pedestrians": 600})
        self.assertEqual(runtime.speed_multiplier, 30)

        with self.assertRaisesRegex(ValueError, "Érvénytelen időgyorsítás"):
            runtime.update_settings({"cars": 100, "speedMultiplier": 7})
        self.assertEqual(
            runtime.simulation.stats(), {"cars": 550, "pedestrians": 600}
        )
        self.assertEqual(runtime.speed_multiplier, 30)

    def test_route_catalog_change_invalidates_the_current_simulation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            network_path = directory / "network.json.gz"
            catalog_path = directory / "catalog.json.gz"
            with gzip.open(network_path, "wt", encoding="utf-8") as stream:
                json.dump({"meta": {"networkId": "test-network"}}, stream)
            with gzip.open(catalog_path, "wt", encoding="utf-8") as stream:
                json.dump({"version": 1}, stream)

            with patch("server.ROUTE_CATALOG_FILE", catalog_path), patch(
                "server.RoadNetwork", return_value=object()
            ), patch.object(
                SimulationRuntime, "_build_render_network", return_value=b"render"
            ):
                runtime = SimulationRuntime(network_path)
                try:
                    self.assertEqual(runtime.route_catalog, {"version": 1})
                    previous_epoch = runtime.simulation_epoch
                    previous_catalog_mtime = runtime.loaded_catalog_mtime_ns
                    self.assertIsNotNone(previous_catalog_mtime)
                    runtime.simulation = object()
                    runtime.configuration = (1, 1, 1)

                    with gzip.open(catalog_path, "wt", encoding="utf-8") as stream:
                        json.dump({"version": 2}, stream)
                    changed_mtime = int(previous_catalog_mtime) + 2_000_000_000
                    os.utime(catalog_path, ns=(changed_mtime, changed_mtime))

                    runtime.health()

                    self.assertEqual(runtime.route_catalog, {"version": 2})
                    self.assertIsNone(runtime.simulation)
                    self.assertIsNone(runtime.configuration)
                    self.assertEqual(runtime.simulation_epoch, previous_epoch + 1)
                finally:
                    runtime.close()

    def test_invalid_cli_ports_are_rejected_without_starting_the_server(self) -> None:
        for port in ("-1", "0", "65536"):
            with self.subTest(port=port):
                with patch("sys.argv", ["server.py", "--port", port]):
                    with redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as captured:
                            parse_arguments()
                self.assertEqual(captured.exception.code, 2)

    def test_supervisor_waits_for_clean_child_shutdown_after_ctrl_c(self) -> None:
        process = Mock()
        process.wait.side_effect = [KeyboardInterrupt(), 0]
        with patch("server.subprocess.Popen", return_value=process):
            with patch("server.sys.argv", ["server.py"]):
                with self.assertRaises(SystemExit) as captured:
                    _run_supervised_child()

        self.assertEqual(captured.exception.code, 0)
        self.assertEqual(process.wait.call_args_list, [call(), call(timeout=3)])
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_supervisor_stops_after_five_consecutive_native_crashes(self) -> None:
        process = Mock()
        process.wait.return_value = -1_073_741_819  # 0xC0000005
        with patch("server.subprocess.Popen", return_value=process) as popen:
            with patch("server.sys.argv", ["server.py"]):
                with patch("server.time.sleep") as sleep:
                    with redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as captured:
                            _run_supervised_child()

        self.assertEqual(captured.exception.code, -1_073_741_819)
        self.assertEqual(popen.call_count, 5)
        self.assertEqual(sleep.call_count, 4)


if __name__ == "__main__":
    unittest.main()
