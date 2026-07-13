"""Függőségmentes helyi webszerver az offline OSM szimulációhoz."""

from __future__ import annotations

import argparse
import atexit
import faulthandler
import gzip
import hashlib
import json
import mimetypes
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

SAFE_CHILD_ENV = "UJBUDA_SAFE_SERVER_CHILD"
SAFE_RUNTIME_ENV = "UJBUDA_SAFE_RUNTIME"
NATIVE_CRASH_EXIT_CODES = frozenset({0xC0000005, 0xC0000409})


def _apply_safe_child_runtime() -> None:
    """Reduce native allocator/CPU variability on the affected Windows host."""

    json.encoder.c_make_encoder = None
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        pointer_size = ctypes.c_size_t
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.GetProcessAffinityMask.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(pointer_size),
            ctypes.POINTER(pointer_size),
        ]
        kernel32.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, pointer_size]
        process = kernel32.GetCurrentProcess()
        process_mask = pointer_size()
        system_mask = pointer_size()
        if not kernel32.GetProcessAffinityMask(
            process, ctypes.byref(process_mask), ctypes.byref(system_mask)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        first_available_cpu = process_mask.value & -process_mask.value
        if not first_available_cpu or not kernel32.SetProcessAffinityMask(
            process, first_available_cpu
        ):
            raise ctypes.WinError(ctypes.get_last_error())
    except (ImportError, OSError, ValueError) as error:
        print(f"Warning: process affinity could not be limited ({error}).", file=sys.stderr)


def _run_supervised_child() -> None:
    """Run the real server in a restartable process with a stable allocator."""

    environment = os.environ.copy()
    environment[SAFE_CHILD_ENV] = "1"
    environment["PYTHONMALLOC"] = "malloc"
    command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]
    consecutive_native_crashes = 0
    while True:
        started = time.monotonic()
        process = subprocess.Popen(command, env=environment)
        try:
            return_code = process.wait()
        except KeyboardInterrupt:
            try:
                return_code = process.wait(timeout=3)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                try:
                    process.terminate()
                    return_code = process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired, KeyboardInterrupt):
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=2)
                    return_code = 130
            raise SystemExit(0 if return_code == 0 else 130) from None
        normalized_code = return_code & 0xFFFFFFFF
        if normalized_code not in NATIVE_CRASH_EXIT_CODES:
            raise SystemExit(return_code)
        if time.monotonic() - started >= 60:
            consecutive_native_crashes = 0
        consecutive_native_crashes += 1
        if consecutive_native_crashes >= 5:
            print(
                "The Python process crashed natively five times; the supervisor is stopping.",
                file=sys.stderr,
            )
            raise SystemExit(return_code)
        delay = min(4.0, 0.75 * consecutive_native_crashes)
        print(
            "The Python process stopped with a native Windows error; "
            f"restarting in {delay:.2f} seconds ({consecutive_native_crashes}/5).",
            file=sys.stderr,
        )
        try:
            time.sleep(delay)
        except KeyboardInterrupt:
            raise SystemExit(130) from None


if __name__ == "__main__" and os.environ.get(SAFE_RUNTIME_ENV, "1") != "0":
    if os.environ.get(SAFE_CHILD_ENV) == "1":
        _apply_safe_child_runtime()
    else:
        _run_supervised_child()

from traffic_simulator.console import configure_utf8_stdio
from traffic_simulator.network_simulation import (
    NetworkTrafficSimulation,
    RoadNetwork,
)

ROOT = Path(__file__).resolve().parent
NETWORK_FILE = ROOT / "data" / "ujbuda_network.json.gz"
ROUTE_CATALOG_FILE = ROOT / "data" / "ujbuda_route_catalog.json.gz"
ERROR_LOG_FILE = ROOT / "error.log"
MAX_REQUEST_BYTES = 64 * 1024
COMPACT_STATE_VERSION = 2
COMPACT_CLIENT_LIMIT = 16
COMPACT_CLIENT_TTL_SECONDS = 120.0
STATIC_FILES = frozenset(
    {
        "index.html",
        "styles.css",
        "src/app.js",
        "src/local-map.js",
        "src/replay-buffer.js",
        "src/simulation-timing.js",
        "src/static-map-worker.js",
        "src/state-protocol.js",
    }
)

_FAULT_LOG_LOCK = threading.Lock()
_FAULT_LOG_HANDLE: Any | None = None


def _runtime_timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _enable_fault_log() -> None:
    """Enable native Python crash traces before the large network is loaded."""

    global _FAULT_LOG_HANDLE
    try:
        handle = ERROR_LOG_FILE.open("a", encoding="utf-8", buffering=1)
    except OSError as error:
        print(f"Warning: error.log cannot be opened ({error}).", file=sys.stderr)
        return
    _FAULT_LOG_HANDLE = handle
    with _FAULT_LOG_LOCK:
        handle.write(
            f"[{_runtime_timestamp()}] server-start "
            f"pid={os.getpid()} python={sys.version.split()[0]} "
            f"executable={sys.executable}\n"
        )
        handle.flush()
    faulthandler.enable(file=handle, all_threads=True)


def _close_fault_log(marker: str) -> None:
    """Write a lifecycle marker and close the crash log exactly once."""

    global _FAULT_LOG_HANDLE
    handle = _FAULT_LOG_HANDLE
    if handle is None:
        return
    with _FAULT_LOG_LOCK:
        handle.write(f"[{_runtime_timestamp()}] {marker} pid={os.getpid()}\n")
        handle.flush()
        if faulthandler.is_enabled():
            faulthandler.disable()
        handle.close()
        _FAULT_LOG_HANDLE = None


if __name__ == "__main__":
    _enable_fault_log()
    atexit.register(_close_fault_log, "process-exit")


class SimulationRuntime:
    """A fix hálózatot kezelő, HTTP-től független 30 Hz-es motor."""

    def __init__(self, network_path: Path) -> None:
        self.instance_id = secrets.token_hex(8)
        self.simulation_epoch = 0
        self.network_path = network_path
        self.lock = threading.RLock()
        self.network: RoadNetwork | None = None
        self.network_meta: dict[str, Any] = {}
        self.network_error: str | None = None
        self.network_etag: str | None = None
        self.render_network_content: bytes | None = None
        self.route_catalog: dict[str, Any] | None = None
        self.loaded_mtime_ns: int | None = None
        self.simulation: NetworkTrafficSimulation | None = None
        self.configuration: tuple[int, int, int] | None = None
        self.running = False
        self.speed_multiplier = 15.0
        self.stop_event = threading.Event()
        self.compact_clients: dict[str, dict[str, Any]] = {}
        self._load_network_if_changed()
        self.thread = threading.Thread(
            target=self._run, name="offline-traffic-simulation", daemon=True
        )
        self.thread.start()

    def _invalidate_network(self, error: str) -> None:
        self.network = None
        self.network_meta = {}
        self.network_error = error
        self.network_etag = None
        self.render_network_content = None
        self.route_catalog = None
        self.loaded_mtime_ns = None
        self.simulation = None
        self.configuration = None
        self.running = False
        self._clear_compact_clients()
        self._advance_simulation_epoch()

    def _clear_compact_clients(self) -> None:
        clients = getattr(self, "compact_clients", None)
        if clients is not None:
            clients.clear()

    def _advance_simulation_epoch(self) -> None:
        self.simulation_epoch = getattr(self, "simulation_epoch", 0) + 1

    def _load_network_if_changed(self) -> None:
        try:
            file_stat = self.network_path.stat()
        except OSError:
            self._invalidate_network(
                "A data/ujbuda_network.json.gz hiányzik. "
                "Futtasd: python tools\\download_ujbuda_osm.py"
            )
            return
        if self.loaded_mtime_ns == file_stat.st_mtime_ns and self.network is not None:
            return
        try:
            with gzip.open(self.network_path, "rt", encoding="utf-8") as network_file:
                payload = json.load(network_file)
            network = RoadNetwork(payload)
            render_content = self._build_render_network(payload)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            self._invalidate_network(f"A helyi hálózati fájl hibás: {error}")
            return
        route_catalog: dict[str, Any] | None = None
        try:
            if ROUTE_CATALOG_FILE.is_file():
                with gzip.open(
                    ROUTE_CATALOG_FILE, "rt", encoding="utf-8"
                ) as catalog_file:
                    route_catalog = json.load(catalog_file)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            # A hálózat önmagában is használható; hibás vagy régi katalógusnál
            # a motor determinisztikusan újraépíti az útvonalakat.
            route_catalog = None
        self.network = network
        self.route_catalog = route_catalog
        self.network_meta = payload.get("meta", {})
        self.render_network_content = render_content
        self.network_etag = f'"{hashlib.sha256(render_content).hexdigest()}"'
        self.loaded_mtime_ns = file_stat.st_mtime_ns
        # Az A* útvonalkészletet csak a kliens configure kérésekor építjük fel;
        # különben a szerverindítás és az első oldalbetöltés ugyanazt kétszer
        # számolná ki.
        self.simulation = None
        self.configuration = None
        self.running = False
        self.network_error = None
        self._clear_compact_clients()
        self._advance_simulation_epoch()

    @staticmethod
    def _build_render_network(payload: dict[str, Any]) -> bytes:
        """Készítsen a böngészőnek kis, kizárólag rajzolási csomagot."""

        turn_edges: list[dict[str, Any]] = []
        segment_speeds: dict[str, float] = {}
        segment_modes: dict[str, set[str]] = {}
        for edge in payload.get("edges", []):
            segment_id = str(edge.get("segmentId") or "")
            speed = edge.get("maxSpeedKph")
            if speed is not None and segment_id not in segment_speeds:
                segment_speeds[segment_id] = speed
            if segment_id:
                segment_modes.setdefault(segment_id, set()).update(
                    str(mode) for mode in edge.get("modes", [])
                )
            if not edge.get("turnLanes"):
                continue
            turn_edges.append(
                {
                    "id": edge.get("id"),
                    "segmentId": segment_id,
                    "from": edge.get("from"),
                    "to": edge.get("to"),
                    "direction": edge.get("direction"),
                    "lanes": edge.get("lanes"),
                    "turnLanes": edge.get("turnLanes"),
                    "maxSpeedKph": speed,
                    "modes": edge.get("modes", []),
                }
            )

        # A letöltött node/segment szótárak már tartalmazzák a rajzoláshoz
        # szükséges mezőket. Helyben egészítjük ki őket, hogy induláskor ne
        # készüljön további ~118 ezer rövid életű szótármásolat.
        segments = payload.get("segments", [])
        if not isinstance(segments, list):
            segments = []
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            segment_id = str(segment.get("id") or "")
            segment["maxSpeedKph"] = segment_speeds.get(segment_id)
            segment["modes"] = sorted(segment_modes.get(segment_id, set()))
        nodes = payload.get("nodes", [])
        if not isinstance(nodes, list):
            nodes = []

        # A teljes nyers éllista innentől már nem kell: a RoadNetwork saját
        # objektumai és a fenti turn_edges megőriznek minden szükséges adatot.
        payload["edges"] = []
        payload["restrictions"] = []
        render_payload = {
            "meta": payload.get("meta", {}),
            "nodes": nodes,
            "segments": segments,
            "edges": turn_edges,
            "restrictions": [],
            "pois": payload.get("pois", []),
        }
        raw = json.dumps(
            render_payload,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        return gzip.compress(raw, compresslevel=6, mtime=0)

    def ensure_network(self) -> RoadNetwork:
        with self.lock:
            self._load_network_if_changed()
            if self.network is None:
                raise RuntimeError(self.network_error or "A helyi úthálózat nem érhető el.")
            return self.network

    def render_network_response(self) -> tuple[bytes, str]:
        with self.lock:
            self.ensure_network()
            if self.render_network_content is None or self.network_etag is None:
                raise RuntimeError("A renderhálózat nem készült el.")
            return self.render_network_content, self.network_etag

    def _run(self) -> None:
        target_interval = 1 / 30
        previous_time = time.perf_counter()
        while not self.stop_event.is_set():
            frame_started = time.perf_counter()
            real_delta = min(frame_started - previous_time, 0.25)
            previous_time = frame_started
            with self.lock:
                simulation = self.simulation if self.running else None
                simulation_delta = real_delta * self.speed_multiplier
            # A belső részlépés megakadályozza a rövid OSM-szakaszok átugrását.
            # A lock minden részlépés után felszabadul, így 60x gyorsításnál sem
            # éheznek ki a HTTP-kérések.
            while simulation is not None and simulation_delta > 0:
                step = min(0.5, simulation_delta)
                with self.lock:
                    if not self.running or self.simulation is not simulation:
                        break
                    simulation.step(step)
                simulation_delta -= step
            spent = time.perf_counter() - frame_started
            self.stop_event.wait(max(0.0, target_interval - spent))

    def configure(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            network = self.ensure_network()
            if "routes" in payload:
                raise ValueError("A helyi szimuláció nem fogad külső útvonalakat.")
            configuration = (
                int(payload.get("cars", 400)),
                int(payload.get("pedestrians", 600)),
                int(payload.get("seed", 110_726)),
            )
            if self.simulation is not None and self.configuration == configuration:
                return self._configuration_response(reused=True)
            simulation_options: dict[str, Any] = {
                "cars": configuration[0],
                "pedestrians": configuration[1],
                "seed": configuration[2],
            }
            route_catalog = getattr(self, "route_catalog", None)
            if route_catalog is not None:
                simulation_options["route_catalog"] = route_catalog
            self.simulation = NetworkTrafficSimulation(
                network, **simulation_options
            )
            self.configuration = configuration
            self.running = False
            self._clear_compact_clients()
            self._advance_simulation_epoch()
            return self._configuration_response(reused=False)

    def _configuration_response(self, *, reused: bool) -> dict[str, Any]:
        if self.simulation is None:
            raise RuntimeError("A szimuláció még nincs konfigurálva.")
        return {
            "configured": True,
            "reused": reused,
            "running": self.running,
            "serverInstanceId": getattr(self, "instance_id", None),
            "simulationEpoch": getattr(self, "simulation_epoch", 0),
            "speedMultiplier": self.speed_multiplier,
            "routeCatalogLoaded": bool(
                getattr(self.simulation, "route_catalog_loaded", False)
            ),
            "stats": self.simulation.stats(),
            "routing": {
                mode: dict(values)
                for mode, values in self.simulation.route_selection_stats.items()
            },
        }

    def control(self, action: str) -> dict[str, Any]:
        with self.lock:
            if self.simulation is None:
                raise RuntimeError(self.network_error or "A szimuláció még nincs konfigurálva.")
            if action == "start":
                self.running = True
            elif action == "pause":
                self.running = False
            elif action == "reset":
                self.running = False
                self.simulation.reset()
                self._clear_compact_clients()
                self._advance_simulation_epoch()
            else:
                raise ValueError(f"Ismeretlen vezérlési művelet: {action}")
            return {
                **self.simulation.snapshot(),
                "configured": True,
                "running": self.running,
                "speedMultiplier": self.speed_multiplier,
                "serverInstanceId": self.instance_id,
                "simulationEpoch": self.simulation_epoch,
            }

    def update_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            if self.simulation is None:
                raise RuntimeError(self.network_error or "A szimuláció még nincs konfigurálva.")
            stats = self.simulation.stats()
            self.simulation.set_agent_targets(
                cars=int(payload.get("cars", stats["cars"])),
                pedestrians=int(payload.get("pedestrians", stats["pedestrians"])),
            )
            updated_stats = self.simulation.stats()
            self.configuration = (
                int(updated_stats["cars"]),
                int(updated_stats["pedestrians"]),
                self.simulation.seed,
            )
            if "speedMultiplier" in payload:
                speed = float(payload["speedMultiplier"])
                if speed not in {1.0, 5.0, 15.0, 30.0, 60.0}:
                    raise ValueError("Érvénytelen időgyorsítás.")
                self.speed_multiplier = speed
            return {"running": self.running, "stats": self.simulation.stats()}

    def snapshot(
        self,
        selected_agent_id: int | None = None,
        known_route_token: str | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            if self.simulation is None:
                return {
                    "configured": False,
                    "running": False,
                    "agents": [],
                    "error": self.network_error,
                    "serverInstanceId": self.instance_id,
                }
            simulation_snapshot = (
                self.simulation.snapshot()
                if selected_agent_id is None
                else self.simulation.snapshot(
                    selected_agent_id=selected_agent_id,
                    known_route_token=known_route_token,
                )
            )
            return {
                "configured": True,
                "running": self.running,
                "speedMultiplier": self.speed_multiplier,
                "routeCatalogLoaded": bool(
                    getattr(self.simulation, "route_catalog_loaded", False)
                ),
                "serverInstanceId": self.instance_id,
                **simulation_snapshot,
            }

    @staticmethod
    def _compact_internal_agent(
        record: tuple[int, ...],
    ) -> tuple[int, int, int, int, int, int]:
        if len(record) == 5:
            return (*record, 0)
        if len(record) != 6:
            raise ValueError("A belső compact ágensrekord mérete érvénytelen.")
        return record

    @staticmethod
    def _compact_full_agent(
        agent_id: int,
        record: tuple[int, int, int, int, int, int],
    ) -> tuple[Any, ...]:
        return (agent_id, *record[:5])

    def _compact_client_can_cache(self, now: float, current_client_id: str) -> bool:
        clients = self.compact_clients
        for client_id, client_state in tuple(clients.items()):
            if now - float(client_state["lastSeen"]) > COMPACT_CLIENT_TTL_SECONDS:
                del clients[client_id]
        return current_client_id in clients or len(clients) < COMPACT_CLIENT_LIMIT

    def snapshot_compact(
        self,
        client_id: str,
        base_revision: int | None = None,
        selected_agent_id: int | None = None,
        known_route_token: str | None = None,
    ) -> dict[str, Any]:
        """Build a per-tab full snapshot or delta using a compact wire schema."""

        with self.lock:
            if self.simulation is None:
                return {
                    "v": COMPACT_STATE_VERSION,
                    "k": "f",
                    "r": 0,
                    "c": False,
                    "run": False,
                    "sid": self.instance_id,
                    "epoch": self.simulation_epoch,
                    "e": self.network_error,
                    "a": [],
                }

            now = time.monotonic()
            can_cache_client = self._compact_client_can_cache(now, client_id)
            previous = self.compact_clients.get(client_id) if can_cache_client else None
            current_agents = {
                agent_id: self._compact_internal_agent(record)
                for agent_id, record in self.simulation.compact_agent_records().items()
            }
            revision = int(previous["revision"]) + 1 if previous is not None else 1
            can_send_delta = (
                previous is not None
                and base_revision is not None
                and base_revision == previous["revision"]
                and previous["epoch"] == self.simulation_epoch
            )
            payload: dict[str, Any] = {
                "v": COMPACT_STATE_VERSION,
                "k": "d" if can_send_delta else "f",
                "r": revision,
                "c": True,
                "run": self.running,
                "speed": self.speed_multiplier,
                "sid": self.instance_id,
                "epoch": self.simulation_epoch,
                "s": self.simulation.stats(),
            }

            if can_send_delta:
                payload["b"] = previous["revision"]
                previous_agents = previous["agents"]
                positions = []
                updates = []
                new_agents = []
                relocated_agents = []
                for agent_id, current_record in current_agents.items():
                    previous_record = previous_agents.get(agent_id)
                    if (
                        previous_record is not None
                        and current_record[5] != previous_record[5]
                    ):
                        relocated_agents.append(agent_id)
                    if previous_record is None or current_record[0] != previous_record[0]:
                        new_agents.append(
                            self._compact_full_agent(agent_id, current_record)
                        )
                        continue
                    if current_record[1:5] != previous_record[1:5]:
                        if current_record[3:5] == previous_record[3:5]:
                            positions.append(
                                (agent_id, current_record[1], current_record[2])
                            )
                        else:
                            updates.append((agent_id, *current_record[1:5]))
                removed_agents = [
                    agent_id
                    for agent_id in previous_agents
                    if agent_id not in current_agents
                ]
                if positions:
                    payload["p"] = positions
                if updates:
                    payload["u"] = updates
                if new_agents:
                    payload["n"] = new_agents
                if removed_agents:
                    payload["x"] = removed_agents
                if relocated_agents:
                    payload["t"] = relocated_agents
            else:
                payload["catalog"] = bool(
                    getattr(self.simulation, "route_catalog_loaded", False)
                )
                payload["g"] = {
                    mode: dict(values)
                    for mode, values in self.simulation.route_selection_stats.items()
                }
                payload["a"] = [
                    self._compact_full_agent(agent_id, record)
                    for agent_id, record in current_agents.items()
                ]
                if current_agents:
                    payload["t"] = list(current_agents)

            if selected_agent_id is not None:
                payload["z"] = self.simulation.compact_selected_agent(
                    selected_agent_id
                )
                payload["q"] = self.simulation.selected_route_snapshot(
                    selected_agent_id, known_route_token
                )
            if can_cache_client:
                self.compact_clients[client_id] = {
                    "revision": revision,
                    "epoch": self.simulation_epoch,
                    "lastSeen": now,
                    "agents": current_agents,
                }
            return payload

    def health(self) -> dict[str, Any]:
        with self.lock:
            self._load_network_if_changed()
            counts = self.network_meta.get("counts", {})
            return {
                "status": "ok",
                "networkLoaded": self.network is not None,
                "networkError": self.network_error,
                "networkId": self.network_meta.get("networkId"),
                "network": counts,
                "configured": self.simulation is not None,
                "running": self.running,
                "serverInstanceId": self.instance_id,
                "simulationEpoch": self.simulation_epoch,
            }

    def close(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)


_RUNTIME_INITIALIZATION_LOCK = threading.Lock()
_RUNTIME_INSTANCE: SimulationRuntime | None = None


def get_runtime() -> SimulationRuntime:
    """Create the large network runtime only after the HTTP port is available."""

    global _RUNTIME_INSTANCE
    if _RUNTIME_INSTANCE is None:
        with _RUNTIME_INITIALIZATION_LOCK:
            if _RUNTIME_INSTANCE is None:
                _RUNTIME_INSTANCE = SimulationRuntime(NETWORK_FILE)
    return _RUNTIME_INSTANCE


def close_runtime() -> None:
    global _RUNTIME_INSTANCE
    with _RUNTIME_INITIALIZATION_LOCK:
        runtime = _RUNTIME_INSTANCE
        _RUNTIME_INSTANCE = None
    if runtime is not None:
        runtime.close()


class LazyRuntime:
    """Compatibility proxy for tests and handlers without import-time loading."""

    def __getattr__(self, name: str) -> Any:
        return getattr(get_runtime(), name)

    def snapshot(
        self,
        selected_agent_id: int | None = None,
        known_route_token: str | None = None,
    ) -> dict[str, Any]:
        return get_runtime().snapshot(
            selected_agent_id=selected_agent_id,
            known_route_token=known_route_token,
        )

    def snapshot_compact(
        self,
        client_id: str,
        base_revision: int | None = None,
        selected_agent_id: int | None = None,
        known_route_token: str | None = None,
    ) -> dict[str, Any]:
        return get_runtime().snapshot_compact(
            client_id=client_id,
            base_revision=base_revision,
            selected_agent_id=selected_agent_id,
            known_route_token=known_route_token,
        )

    def close(self) -> None:
        close_runtime()

    def is_initialized(self) -> bool:
        return _RUNTIME_INSTANCE is not None


RUNTIME = LazyRuntime()


class RobustThreadingHTTPServer(ThreadingHTTPServer):
    """Windowsbarát HTTP-szerver kizárólagos binddal és tiszta bontással."""

    allow_reuse_address = False

    def server_bind(self) -> None:
        # Windows alatt a SO_REUSEADDR két élő processznek is megengedheti
        # ugyanazt a portot. Az exclusive bind ehelyett egyértelmű indulási
        # hibát ad a második példánynak.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(
                socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1
            )
        super().server_bind()

    def handle_error(self, request: object, client_address: object) -> None:
        error = sys.exc_info()[1]
        if isinstance(error, ConnectionError):
            return
        super().handle_error(request, client_address)


class ApplicationHandler(BaseHTTPRequestHandler):
    server_version = "UjbudaOfflineTraffic/2.0"
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        parsed_url = urlparse(self.path)
        path = unquote(parsed_url.path)
        if path == "/api/health":
            self._send_json(RUNTIME.health())
            return
        if path == "/api/network":
            self._send_network()
            return
        if path == "/api/simulation/state":
            try:
                query = parse_qs(parsed_url.query, keep_blank_values=True)
                selected_values = query.get("selectedAgentId", [])
                token_values = query.get("knownRouteToken", [])
                protocol_values = query.get("protocol", [])
                client_values = query.get("clientId", [])
                revision_values = query.get("baseRevision", [])
                if any(
                    len(values) > 1
                    for values in (
                        selected_values,
                        token_values,
                        protocol_values,
                        client_values,
                        revision_values,
                    )
                ):
                    raise ValueError("Az állapotlekérdezés paramétere ismétlődik.")
                selected_agent_id = (
                    int(selected_values[0]) if selected_values else None
                )
                if selected_agent_id is not None and selected_agent_id <= 0:
                    raise ValueError("A kiválasztott ágens azonosítója érvénytelen.")
                known_route_token = token_values[0] if token_values else None
                if known_route_token is not None and len(known_route_token) > 64:
                    raise ValueError("Az útvonaltoken túl hosszú.")
                protocol = protocol_values[0] if protocol_values else None
                if protocol is None:
                    if client_values or revision_values:
                        raise ValueError("A delta paramétereihez protocol=2 szükséges.")
                    response = RUNTIME.snapshot(
                        selected_agent_id=selected_agent_id,
                        known_route_token=known_route_token,
                    )
                elif protocol == "2":
                    if len(client_values) != 1:
                        raise ValueError("A delta kliensazonosítója hiányzik.")
                    client_id = client_values[0]
                    if not 8 <= len(client_id) <= 64 or any(
                        not (
                            character.isascii()
                            and (character.isalnum() or character in "-_")
                        )
                        for character in client_id
                    ):
                        raise ValueError("A delta kliensazonosítója érvénytelen.")
                    base_revision = (
                        int(revision_values[0]) if revision_values else None
                    )
                    if base_revision is not None and base_revision < 0:
                        raise ValueError("A delta alapverziója érvénytelen.")
                    response = RUNTIME.snapshot_compact(
                        client_id=client_id,
                        base_revision=base_revision,
                        selected_agent_id=selected_agent_id,
                        known_route_token=known_route_token,
                    )
                else:
                    raise ValueError("Az állapotprotokoll verziója nem támogatott.")
                self._send_json(response)
            except ValueError as error:
                self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            return

        relative_path = "index.html" if path == "/" else path.removeprefix("/")
        if relative_path not in STATIC_FILES:
            self._send_text_error(
                HTTPStatus.NOT_FOUND, "Az erőforrás nem található."
            )
            return
        file_path = ROOT / relative_path
        try:
            content = file_path.read_bytes()
        except OSError:
            self._send_text_error(
                HTTPStatus.NOT_FOUND, "Az erőforrás nem található."
            )
            return
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            if path == "/api/simulation/configure":
                response = RUNTIME.configure(payload)
            elif path == "/api/simulation/control":
                response = RUNTIME.control(str(payload.get("action", "")))
            elif path == "/api/simulation/settings":
                response = RUNTIME.update_settings(payload)
            else:
                self._send_json(
                    {"error": "Az API-végpont nem található."},
                    HTTPStatus.NOT_FOUND,
                )
                return
            self._send_json(response)
        except (ValueError, TypeError, RuntimeError, json.JSONDecodeError) as error:
            self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def _send_network(self) -> None:
        try:
            runtime = get_runtime()
            content, network_etag = runtime.render_network_response()
        except (OSError, RuntimeError) as error:
            self._send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
            return
        if self.headers.get("If-None-Match") == network_etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", network_etag)
            self.send_header("Cache-Control", "private, no-cache")
            self.end_headers()
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "private, no-cache")
        self.send_header("ETag", network_etag)
        self.end_headers()
        self.wfile.write(content)

    def _read_json(self) -> dict[str, Any]:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Érvénytelen Content-Length fejléc.") from error
        if content_length > MAX_REQUEST_BYTES:
            # HTTP/1.1 alatt a be nem olvasott törzs különben a következő
            # kérés státuszsorának látszana ugyanazon a kapcsolaton.
            self.close_connection = True
            raise ValueError("A kérés mérete érvénytelen vagy túl nagy.")
        if content_length <= 0:
            raise ValueError("A kérés mérete érvénytelen vagy túl nagy.")
        payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("A JSON törzsének objektumnak kell lennie.")
        return payload

    def _send_json(
        self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK
    ) -> None:
        content = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        use_gzip = len(content) >= 1024 and self._accepts_gzip()
        if use_gzip:
            content = gzip.compress(content, compresslevel=1, mtime=0)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Vary", "Accept-Encoding")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(content)

    def _accepts_gzip(self) -> bool:
        qualities: dict[str, float] = {}
        for value in self.headers.get("Accept-Encoding", "").lower().split(","):
            parts = [part.strip() for part in value.split(";")]
            if not parts or not parts[0]:
                continue
            quality = 1.0
            for parameter in parts[1:]:
                if parameter.startswith("q="):
                    try:
                        quality = float(parameter[2:])
                    except ValueError:
                        quality = 0.0
            qualities[parts[0]] = quality
        if "gzip" in qualities:
            return qualities["gzip"] > 0
        return qualities.get("*", 0.0) > 0

    def _send_text_error(self, status: HTTPStatus, message: str) -> None:
        """Send Hungarian UTF-8 text without putting it in the HTTP reason phrase."""

        content = f"{int(status)} {message}\n".encode("utf-8")
        # A send_response csak a szabványos ASCII/Latin-1 státuszszöveget írja
        # a fejlécbe; a magyar üzenet az UTF-8 törzsbe kerül.
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, message_format: str, *args: object) -> None:
        try:
            status = int(args[1]) if len(args) > 1 else 0
        except (TypeError, ValueError):
            status = 0
        if status >= 400:
            super().log_message(message_format, *args)


def parse_http_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "A HTTP-port 1 es 65535 kozotti egesz szam legyen."
        ) from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError(
            "A HTTP-port 1 es 65535 kozotti egesz szam legyen."
        )
    return port


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Újbuda offline forgalomszimulátor")
    parser.add_argument("--host", default="127.0.0.1", help="Figyelt hálózati cím")
    parser.add_argument("--port", default=8080, type=parse_http_port, help="HTTP port")
    return parser.parse_args()


def main() -> None:
    configure_utf8_stdio()
    arguments = parse_arguments()
    try:
        server = RobustThreadingHTTPServer(
            (arguments.host, arguments.port), ApplicationHandler
        )
    except OSError as error:
        print(
            f"Indítási hiba: a {arguments.host}:{arguments.port} cím nem "
            f"foglalható le ({error}).",
            file=sys.stderr,
        )
        _close_fault_log("startup-failed")
        raise SystemExit(1) from None
    print(
        f"HTTP-port lefoglalva ({arguments.host}:{arguments.port}), "
        "a helyi térkép betöltése folyamatban…"
    )
    try:
        runtime = get_runtime()
    except Exception as error:
        server.server_close()
        print(f"Indítási hiba: a helyi térkép nem tölthető be ({error}).", file=sys.stderr)
        _close_fault_log("startup-failed")
        raise SystemExit(1) from None
    print(f"Újbuda offline forgalomszimulátor: http://{arguments.host}:{arguments.port}")
    if runtime.network_error:
        print(f"Térképadat: {runtime.network_error}")
    else:
        print(f"Térképadat: {NETWORK_FILE}")
    print("Leállítás: Ctrl+C")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nLeállítás...")
    finally:
        server.server_close()
        close_runtime()
        _close_fault_log("clean-shutdown")


if __name__ == "__main__":
    main()
