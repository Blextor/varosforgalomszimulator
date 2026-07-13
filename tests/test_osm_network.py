from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

from traffic_simulator.osm_network import (
    OSMNetworkError,
    build_network,
    download_ujbuda_network,
    fetch_overpass_json,
    load_network_gzip,
    pois_overpass_query,
    restrictions_overpass_query,
    roads_overpass_query,
    write_network_gzip,
)


ROADS_PAYLOAD = {
    "osm3s": {"timestamp_osm_base": "2026-07-09T12:00:00Z"},
    "elements": [
        {"type": "node", "id": 1, "lat": 47.4700, "lon": 19.0300},
        {
            "type": "node",
            "id": 2,
            "lat": 47.4705,
            "lon": 19.0310,
            "tags": {"highway": "traffic_signals"},
        },
        {
            "type": "node",
            "id": 3,
            "lat": 47.4710,
            "lon": 19.0320,
            "tags": {"highway": "crossing", "crossing": "marked"},
        },
        {"type": "node", "id": 4, "lat": 47.4715, "lon": 19.0330},
        {"type": "node", "id": 5, "lat": 47.4720, "lon": 19.0340},
        {"type": "node", "id": 6, "lat": 47.4725, "lon": 19.0350},
        {
            "type": "way",
            "id": 10,
            "nodes": [1, 2, 3],
            "tags": {
                "highway": "residential",
                "name": "Teszt utca",
                "lanes": "3",
                "lanes:forward": "2",
                "lanes:backward": "1",
                "turn:lanes:forward": "left|through;right",
                "turn:lanes:backward": "through|right",
                "oneway": "no",
                "maxspeed": "50",
            },
        },
        {
            "type": "way",
            "id": 11,
            "nodes": [3, 4],
            "tags": {
                "highway": "service",
                "oneway": "yes",
                "lanes": "1",
                "maxspeed": "20",
            },
        },
        {
            "type": "way",
            "id": 12,
            "nodes": [4, 5],
            "tags": {"highway": "footway", "name": "Sétaút"},
        },
        {
            "type": "way",
            "id": 13,
            "nodes": [5, 6],
            "tags": {
                "highway": "residential",
                "oneway": "-1",
                "lanes": "1",
                "turn:lanes": "left|through",
                "maxspeed": "30 mph",
            },
        },
    ],
}


RESTRICTIONS_PAYLOAD = {
    "osm3s": {"timestamp_osm_base": "2026-07-09T12:01:00Z"},
    "elements": [
        {
            "type": "relation",
            "id": 221998,
            "bounds": {
                "minlat": 47.42,
                "minlon": 18.95,
                "maxlat": 47.50,
                "maxlon": 19.08,
            },
            "members": [],
            "tags": {"type": "boundary", "name": "Budapest XI. kerület"},
        },
        {
            "type": "relation",
            "id": 99,
            "members": [
                {"type": "way", "ref": 10, "role": "from"},
                {"type": "way", "ref": 11, "role": "to"},
                {"type": "node", "ref": 3, "role": "via"},
            ],
            "tags": {
                "type": "restriction",
                "restriction": "no_left_turn",
                "except": "bicycle;psv",
            },
        },
    ],
}


POI_PAYLOAD = {
    "osm3s": {"timestamp_osm_base": "2026-07-09T12:02:00Z"},
    "elements": [
        {
            "type": "node",
            "id": 100,
            "lat": 47.4702,
            "lon": 19.0302,
            "tags": {"shop": "hairdresser", "name": "Teszt fodrászat"},
        },
        {
            "type": "node",
            "id": 100,
            "lat": 47.4702,
            "lon": 19.0302,
            "tags": {"shop": "hairdresser", "name": "Teszt fodrászat"},
        },
        {
            "type": "way",
            "id": 101,
            "center": {"lat": 47.4703, "lon": 19.0303},
            "tags": {"amenity": "parking", "name": "Teszt parkoló"},
        },
        {
            "type": "relation",
            "id": 102,
            "center": {"lat": 47.4704, "lon": 19.0304},
            "tags": {
                "public_transport": "station",
                "railway": "station",
                "name": "Teszt állomás",
            },
        },
        {
            "type": "node",
            "id": 103,
            "lat": 47.4705,
            "lon": 19.0305,
            "tags": {"amenity": "restaurant"},
        },
        {
            "type": "way",
            "id": 104,
            "center": {"lat": 47.4706, "lon": 19.0306},
            "tags": {"shop": "mall"},
        },
        {
            "type": "node",
            "id": 105,
            "lat": 47.4707,
            "lon": 19.0307,
            "tags": {"healthcare": "doctor"},
        },
        {
            "type": "node",
            "id": 106,
            "lat": 47.4708,
            "lon": 19.0308,
            "tags": {"amenity": "school"},
        },
        {
            "type": "relation",
            "id": 107,
            "center": {"lat": 47.4709, "lon": 19.0309},
            "tags": {"tourism": "attraction"},
        },
        {
            "type": "node",
            "id": 108,
            "lat": 47.4710,
            "lon": 19.0310,
            "tags": {"amenity": "bench"},
        },
        {
            "type": "way",
            "id": 109,
            "tags": {"shop": "supermarket"},
        },
    ],
}


class OSMNetworkBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.network = build_network(
            ROADS_PAYLOAD,
            RESTRICTIONS_PAYLOAD,
            POI_PAYLOAD,
            generated_at="2026-07-10T00:00:00Z",
        )

    def test_builds_requested_schema_and_bounds(self) -> None:
        self.assertEqual(
            set(self.network),
            {"meta", "nodes", "segments", "edges", "restrictions", "pois"},
        )
        self.assertEqual(
            self.network["meta"]["bounds"],
            {"south": 47.42, "west": 18.95, "north": 47.50, "east": 19.08},
        )
        self.assertEqual(self.network["meta"]["counts"]["nodes"], 6)
        self.assertEqual(self.network["meta"]["counts"]["segments"], 5)
        self.assertEqual(self.network["meta"]["counts"]["edges"], 10)
        self.assertEqual(self.network["meta"]["counts"]["pois"], 9)
        self.assertEqual(self.network["meta"]["osmTimestamp"], "2026-07-09T12:02:00Z")
        self.assertEqual(
            self.network["meta"]["networkId"], "ujbuda-osm-20260709T120200Z"
        )
        self.assertEqual(
            self.network["meta"]["coverage"],
            {
                "ways": 4,
                "waysWithLanes": 3,
                "waysWithTurnLanes": 2,
                "waysWithMaxspeed": 3,
            },
        )

        nodes = {node["id"]: node for node in self.network["nodes"]}
        self.assertTrue(nodes[2]["trafficSignal"])
        self.assertTrue(nodes[3]["crossing"])
        self.assertEqual(set(nodes[1]), {"id", "lat", "lng", "trafficSignal", "crossing"})

    def test_preserves_lanes_turns_speeds_and_modes(self) -> None:
        segments = {segment["id"]: segment for segment in self.network["segments"]}
        first = segments["w10:0"]
        self.assertEqual(first["totalLanes"], 3)
        self.assertEqual(first["forwardLanes"], 2)
        self.assertEqual(first["backwardLanes"], 1)
        self.assertEqual(first["osmTags"]["lanes:forward"], "2")
        self.assertEqual(
            first["osmTags"]["turn:lanes:forward"], "left|through;right"
        )

        edges = {edge["id"]: edge for edge in self.network["edges"]}
        forward = edges["w10:0:f"]
        backward = edges["w10:0:b"]
        self.assertEqual(forward["direction"], "forward")
        self.assertEqual(forward["modes"], ["car", "pedestrian"])
        self.assertEqual(forward["lanes"], 2)
        self.assertEqual(forward["totalLanes"], 3)
        self.assertEqual(forward["turnLanes"], [["left"], ["through", "right"]])
        self.assertEqual(backward["turnLanes"], [["through"], ["right"]])
        self.assertEqual(forward["maxSpeedKph"], 50.0)
        self.assertEqual(backward["maxSpeedKph"], 50.0)
        self.assertGreater(forward["lengthMeters"], 1)

        self.assertEqual(edges["w11:0:f"]["modes"], ["car", "pedestrian"])
        self.assertEqual(edges["w11:0:b"]["modes"], ["pedestrian"])
        self.assertEqual(edges["w12:0:f"]["modes"], ["pedestrian"])
        self.assertNotIn("car", edges["w13:0:f"]["modes"])
        self.assertNotIn("car", edges["w13:0:b"]["modes"])
        self.assertEqual(
            self.network["meta"]["pruning"]["modes"]["car"]["removedModeEdges"],
            1,
        )
        self.assertEqual(edges["w13:0:b"]["turnLanes"], [["left"], ["through"]])
        self.assertAlmostEqual(edges["w13:0:b"]["maxSpeedKph"], 48.280, places=3)

        self.assertEqual(segments["w12:0"]["modes"], ["pedestrian"])
        self.assertEqual(segments["w13:0"]["modes"], ["pedestrian"])

    def test_parses_and_deduplicates_pois(self) -> None:
        self.assertEqual(len(self.network["pois"]), 9)
        self.assertEqual(
            self.network["meta"]["poiCategories"],
            {
                "parking": 1,
                "transit": 1,
                "shopping": 1,
                "food": 1,
                "health": 1,
                "education": 1,
                "leisure": 1,
                "service": 1,
                "other": 1,
            },
        )
        pois = {poi["id"]: poi for poi in self.network["pois"]}
        hairdresser = pois["node/100"]
        self.assertEqual(hairdresser["name"], "Teszt fodrászat")
        self.assertEqual(hairdresser["category"], "service")
        self.assertEqual(hairdresser["subtype"], "hairdresser")
        self.assertEqual(hairdresser["tripModes"], ["car", "pedestrian"])
        self.assertEqual(hairdresser["tags"]["shop"], "hairdresser")

        parking = pois["way/101"]
        self.assertEqual((parking["lat"], parking["lng"]), (47.4703, 19.0303))
        self.assertEqual(parking["category"], "parking")
        self.assertEqual(parking["weight"], 3)

        station = pois["relation/102"]
        self.assertEqual(station["category"], "transit")
        self.assertEqual(station["tripModes"], ["pedestrian"])

    def test_generic_access_does_not_promote_an_incompatible_road_class(self) -> None:
        roads = {
            "elements": [
                {"type": "node", "id": 1, "lat": 47.47, "lon": 19.03},
                {"type": "node", "id": 2, "lat": 47.471, "lon": 19.031},
                {"type": "node", "id": 3, "lat": 47.472, "lon": 19.032},
                {"type": "node", "id": 4, "lat": 47.473, "lon": 19.033},
                {"type": "node", "id": 5, "lat": 47.474, "lon": 19.034},
                {
                    "type": "way",
                    "id": 200,
                    "nodes": [1, 2],
                    "tags": {"highway": "residential"},
                },
                {
                    "type": "way",
                    "id": 201,
                    "nodes": [2, 3],
                    "tags": {"highway": "footway", "access": "yes"},
                },
                {
                    "type": "way",
                    "id": 202,
                    "nodes": [2, 4],
                    "tags": {"highway": "footway", "motorcar": "yes"},
                },
                {
                    "type": "way",
                    "id": 203,
                    "nodes": [2, 5],
                    "tags": {"highway": "motorway", "access": "yes"},
                },
            ]
        }
        network = build_network(roads, RESTRICTIONS_PAYLOAD)
        edges = {edge["id"]: edge for edge in network["edges"]}

        self.assertEqual(edges["w201:0:f"]["modes"], ["pedestrian"])
        self.assertEqual(edges["w202:0:f"]["modes"], ["car", "pedestrian"])
        self.assertEqual(edges["w203:0:f"]["modes"], ["car"])

    def test_prunes_each_modes_disconnected_components(self) -> None:
        roads = {
            "elements": [
                *[
                    {
                        "type": "node",
                        "id": node_id,
                        "lat": 47.46 + node_id * 0.00001,
                        "lon": 19.02 + node_id * 0.00001,
                    }
                    for node_id in (1, 2, 3, 4, 10, 11, 20, 21)
                ],
                {
                    "type": "way",
                    "id": 100,
                    "nodes": [1, 2, 3],
                    "tags": {"highway": "residential"},
                },
                {
                    "type": "way",
                    "id": 101,
                    "nodes": [3, 4],
                    "tags": {"highway": "footway"},
                },
                {
                    "type": "way",
                    "id": 102,
                    "nodes": [10, 11],
                    "tags": {"highway": "residential"},
                },
                {
                    "type": "way",
                    "id": 103,
                    "nodes": [20, 21],
                    "tags": {"highway": "footway"},
                },
            ]
        }
        restrictions = {
            "elements": [
                {
                    "type": "relation",
                    "id": 221998,
                    "bounds": {
                        "minlat": 47.42,
                        "minlon": 18.95,
                        "maxlat": 47.50,
                        "maxlon": 19.08,
                    },
                    "members": [],
                    "tags": {"type": "boundary"},
                },
                {
                    "type": "relation",
                    "id": 2000,
                    "members": [
                        {"type": "way", "ref": 102, "role": "from"},
                        {"type": "way", "ref": 100, "role": "to"},
                        {"type": "node", "ref": 10, "role": "via"},
                    ],
                    "tags": {"type": "restriction", "restriction": "no_right_turn"},
                },
            ]
        }

        network = build_network(roads, restrictions)
        self.assertEqual(
            {node["id"] for node in network["nodes"]},
            {1, 2, 3, 4},
        )
        self.assertEqual(
            {segment["id"] for segment in network["segments"]},
            {"w100:0", "w100:1", "w101:0"},
        )
        self.assertEqual(len(network["edges"]), 6)
        self.assertEqual(network["restrictions"], [])

        pruning = network["meta"]["pruning"]
        self.assertEqual(
            pruning["before"],
            {"nodes": 8, "segments": 5, "edges": 10, "restrictions": 1},
        )
        self.assertEqual(
            pruning["after"],
            {"nodes": 4, "segments": 3, "edges": 6, "restrictions": 0},
        )
        self.assertEqual(pruning["modes"]["car"]["componentNodeSizes"], [3, 2])
        self.assertEqual(
            pruning["modes"]["pedestrian"]["componentNodeSizes"],
            [4, 2, 2],
        )

    def test_builds_turn_restrictions(self) -> None:
        self.assertEqual(
            self.network["restrictions"],
            [
                {
                    "id": 99,
                    "restriction": "no_left_turn",
                    "fromWays": [10],
                    "toWays": [11],
                    "viaNodes": [3],
                    "viaWays": [],
                    "except": ["bicycle", "psv"],
                }
            ],
        )

    def test_gzip_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            target = Path(temporary_directory) / "network.json.gz"
            write_network_gzip(self.network, target)
            self.assertEqual(load_network_gzip(target), self.network)
            self.assertLess(target.stat().st_size, len(json.dumps(self.network)))

    def test_invalid_payload_is_rejected(self) -> None:
        with self.assertRaises(OSMNetworkError):
            build_network({}, RESTRICTIONS_PAYLOAD)


class OverpassRequestTests(unittest.TestCase):
    def test_queries_target_ujbuda_and_are_separate(self) -> None:
        roads = roads_overpass_query()
        restrictions = restrictions_overpass_query()
        pois = pois_overpass_query()
        self.assertIn("relation(221998)", roads)
        self.assertIn('["highway"]', roads)
        self.assertNotIn('^restriction', roads)
        self.assertIn("relation(221998)", restrictions)
        self.assertIn('^restriction', restrictions)
        self.assertIn("relation(221998)", pois)
        self.assertIn("amenity|shop|tourism|leisure", pois)
        self.assertIn("office|craft|healthcare|public_transport", pois)
        self.assertIn('["highway"="bus_stop"]', pois)
        self.assertIn("tram_stop|station|halt|subway_entrance", pois)
        self.assertIn("out tags center qt", pois)

    def test_transient_failure_is_retried_without_real_network(self) -> None:
        requests = []
        delays = []

        class Response:
            headers = {"Content-Encoding": ""}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def read(self):
                return b'{"elements": []}'

        def opener(request, timeout):
            requests.append((request, timeout))
            if len(requests) == 1:
                raise URLError("temporary")
            return Response()

        result = fetch_overpass_json(
            "[out:json];node(1);out;",
            retries=1,
            backoff_seconds=0.25,
            user_agent="fixture-test/1.0",
            opener=opener,
            sleep=delays.append,
        )

        self.assertEqual(result, {"elements": []})
        self.assertEqual(len(requests), 2)
        self.assertEqual(delays, [0.25])
        self.assertEqual(requests[0][0].get_header("User-agent"), "fixture-test/1.0")

    def test_downloader_fetches_roads_restrictions_and_pois(self) -> None:
        payloads = [ROADS_PAYLOAD, RESTRICTIONS_PAYLOAD, POI_PAYLOAD]
        with tempfile.TemporaryDirectory() as temporary_directory:
            target = Path(temporary_directory) / "network.json.gz"
            with patch(
                "traffic_simulator.osm_network.fetch_overpass_json",
                side_effect=payloads,
            ) as fetch:
                network = download_ujbuda_network(
                    target,
                    endpoint="https://example.invalid/interpreter",
                    poi_endpoint="https://poi.example.invalid/interpreter",
                    retries=0,
                )

            self.assertEqual(fetch.call_count, 3)
            queries = [call.args[0] for call in fetch.call_args_list]
            self.assertIn('["highway"]', queries[0])
            self.assertIn('^restriction', queries[1])
            self.assertIn("amenity|shop|tourism|leisure", queries[2])
            self.assertEqual(
                fetch.call_args_list[2].kwargs["endpoint"],
                "https://poi.example.invalid/interpreter",
            )
            self.assertEqual(network["meta"]["counts"]["pois"], 9)
            self.assertEqual(
                network["meta"]["poiSourceEndpoint"],
                "https://poi.example.invalid/interpreter",
            )
            self.assertEqual(load_network_gzip(target), network)


if __name__ == "__main__":
    unittest.main()
