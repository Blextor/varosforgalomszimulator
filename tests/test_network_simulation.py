from __future__ import annotations

import json
import unittest

from traffic_simulator.network_simulation import (
    NetworkTrafficSimulation,
    RoadNetwork,
)


def network_fixture() -> dict:
    return {
        "meta": {"bounds": {"south": 47.47, "west": 19.03, "north": 47.48, "east": 19.05}},
        "nodes": [
            {"id": 1, "lat": 47.47, "lng": 19.03},
            {"id": 2, "lat": 47.47, "lng": 19.04, "trafficSignal": True},
            {"id": 3, "lat": 47.47, "lng": 19.05},
            {"id": 4, "lat": 47.48, "lng": 19.04},
        ],
        "segments": [],
        "edges": [
            {
                "id": "a-f",
                "segmentId": "a",
                "wayId": 10,
                "from": 1,
                "to": 2,
                "modes": ["car", "pedestrian"],
                "lanes": 2,
                "totalLanes": 4,
                "direction": "forward",
                "turnLanes": [["left"], ["through"]],
                "maxSpeedKph": 50,
                "highway": "primary",
            },
            {
                "id": "a-b",
                "segmentId": "a",
                "wayId": 10,
                "from": 2,
                "to": 1,
                "modes": ["car", "pedestrian"],
                "lanes": 2,
                "totalLanes": 4,
                "direction": "backward",
                "maxSpeedKph": 50,
                "highway": "primary",
            },
            {
                "id": "b-f",
                "segmentId": "b",
                "wayId": 20,
                "from": 2,
                "to": 3,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "forward",
                "maxSpeedKph": 30,
                "highway": "residential",
            },
            {
                "id": "c-f",
                "segmentId": "c",
                "wayId": 30,
                "from": 2,
                "to": 4,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "forward",
                "maxSpeedKph": 30,
                "highway": "residential",
            },
            {
                "id": "b-loop",
                "segmentId": "b2",
                "wayId": 20,
                "from": 3,
                "to": 2,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "backward",
                "maxSpeedKph": 30,
                "highway": "residential",
            },
            {
                "id": "c-loop",
                "segmentId": "c2",
                "wayId": 30,
                "from": 4,
                "to": 2,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "backward",
                "maxSpeedKph": 30,
                "highway": "residential",
            },
        ],
        "restrictions": [
            {
                "id": 100,
                "restriction": "no_right_turn",
                "fromWays": [10],
                "toWays": [20],
                "viaNodes": [2],
                "viaWays": [],
                "except": "",
            }
        ],
    }


def poi_routing_fixture() -> dict:
    return {
        "meta": {
            "bounds": {
                "south": 47.0,
                "west": 19.0,
                "north": 47.001,
                "east": 19.001,
            }
        },
        "nodes": [
            {"id": 1, "lat": 47.0, "lng": 19.0},
            {"id": 2, "lat": 47.0, "lng": 19.0001},
            {"id": 3, "lat": 47.0, "lng": 19.0002},
            {"id": 4, "lat": 47.0001, "lng": 19.0001},
        ],
        "segments": [],
        "edges": [
            {
                "id": "car-12",
                "segmentId": "car-a",
                "wayId": 100,
                "from": 1,
                "to": 2,
                "modes": ["car"],
                "lanes": 1,
                "lengthMeters": 10,
                "maxSpeedKph": 30,
                "highway": "residential",
            },
            {
                "id": "car-21",
                "segmentId": "car-a",
                "wayId": 100,
                "from": 2,
                "to": 1,
                "modes": ["car"],
                "lanes": 1,
                "lengthMeters": 10,
                "maxSpeedKph": 30,
                "highway": "residential",
            },
            {
                "id": "car-23",
                "segmentId": "car-b",
                "wayId": 101,
                "from": 2,
                "to": 3,
                "modes": ["car"],
                "lanes": 1,
                "lengthMeters": 10,
                "maxSpeedKph": 30,
                "highway": "residential",
            },
            {
                "id": "car-32",
                "segmentId": "car-b",
                "wayId": 101,
                "from": 3,
                "to": 2,
                "modes": ["car"],
                "lanes": 1,
                "lengthMeters": 10,
                "maxSpeedKph": 30,
                "highway": "residential",
            },
            {
                "id": "ped-14",
                "segmentId": "ped-a",
                "wayId": 200,
                "from": 1,
                "to": 4,
                "modes": ["pedestrian"],
                "lanes": 1,
                "lengthMeters": 12,
                "maxSpeedKph": 5,
                "highway": "footway",
            },
            {
                "id": "ped-41",
                "segmentId": "ped-a",
                "wayId": 200,
                "from": 4,
                "to": 1,
                "modes": ["pedestrian"],
                "lanes": 1,
                "lengthMeters": 12,
                "maxSpeedKph": 5,
                "highway": "footway",
            },
            {
                "id": "ped-43",
                "segmentId": "ped-b",
                "wayId": 201,
                "from": 4,
                "to": 3,
                "modes": ["pedestrian"],
                "lanes": 1,
                "lengthMeters": 12,
                "maxSpeedKph": 5,
                "highway": "footway",
            },
            {
                "id": "ped-34",
                "segmentId": "ped-b",
                "wayId": 201,
                "from": 3,
                "to": 4,
                "modes": ["pedestrian"],
                "lanes": 1,
                "lengthMeters": 12,
                "maxSpeedKph": 5,
                "highway": "footway",
            },
        ],
        "restrictions": [],
        "pois": [
            {
                "id": "node/9001",
                "osmType": "node",
                "osmId": 9001,
                "lat": 47.0,
                "lng": 19.0,
                "name": "Otthon",
                "category": "residential",
                "subtype": "apartments",
                "tags": {"building": "apartments"},
                "tripModes": ["car", "pedestrian"],
                "weight": 2,
            },
            {
                "id": "node/9002",
                "osmType": "node",
                "osmId": 9002,
                "lat": 47.0,
                "lng": 19.0002,
                "name": "Bevásárlóközpont",
                "category": "shopping",
                "subtype": "mall",
                "tags": {"shop": "mall"},
                "tripModes": ["car", "pedestrian"],
                "weight": 4,
            },
        ],
    }


def geographic_poi_fixture() -> dict:
    south = 47.43
    west = 19.0
    nodes = []
    edges = []
    pois = []
    categories = (
        "shopping",
        "food",
        "health",
        "education",
        "service",
        "leisure",
        "parking",
        "transit",
    )
    for row in range(5):
        for column in range(5):
            node_id = row * 5 + column + 1
            latitude = south + row * 0.001
            longitude = west + column * 0.001
            nodes.append({"id": node_id, "lat": latitude, "lng": longitude})
            category = categories[(row + column) % len(categories)]
            pois.append(
                {
                    "id": f"node/{10_000 + node_id}",
                    "osmType": "node",
                    "osmId": 10_000 + node_id,
                    "lat": latitude,
                    "lng": longitude,
                    "name": f"Célpont {row}-{column}",
                    "category": category,
                    "subtype": "shop" if category == "shopping" else category,
                    "tags": {"name": f"Célpont {row}-{column}"},
                    "tripModes": ["car", "pedestrian"],
                    "weight": 2,
                }
            )
            pois.append(
                {
                    "id": f"node/{20_000 + node_id}",
                    "osmType": "node",
                    "osmId": 20_000 + node_id,
                    "lat": latitude,
                    "lng": longitude,
                    "name": "",
                    "category": "other",
                    "subtype": "waste_basket",
                    "tags": {"amenity": "waste_basket"},
                    "tripModes": ["car", "pedestrian"],
                    "weight": 9,
                }
            )

    way_id = 1_000
    for row in range(5):
        for column in range(5):
            node_id = row * 5 + column + 1
            for neighbor_id in (
                node_id + 1 if column < 4 else None,
                node_id + 5 if row < 4 else None,
            ):
                if neighbor_id is None:
                    continue
                segment_id = f"grid-{node_id}-{neighbor_id}"
                for from_node, to_node, direction in (
                    (node_id, neighbor_id, "forward"),
                    (neighbor_id, node_id, "backward"),
                ):
                    edges.append(
                        {
                            "id": f"{segment_id}-{direction}",
                            "segmentId": segment_id,
                            "wayId": way_id,
                            "from": from_node,
                            "to": to_node,
                            "modes": ["car", "pedestrian"],
                            "lanes": 1,
                            "lengthMeters": 100,
                            "maxSpeedKph": 30,
                            "highway": "residential",
                        }
                    )
                way_id += 1
    return {
        "meta": {
            "bounds": {
                "south": south,
                "west": west,
                "north": south + 0.004,
                "east": west + 0.004,
            }
        },
        "nodes": nodes,
        "segments": [],
        "edges": edges,
        "restrictions": [],
        "pois": pois,
    }


class RoadNetworkTests(unittest.TestCase):
    def test_turn_restriction_filters_forbidden_way(self) -> None:
        network = RoadNetwork(network_fixture())
        incoming = network.edges_by_id["a-f"]
        outgoing = network.allowed_outgoing(incoming, "car")
        self.assertEqual({edge.way_id for edge in outgoing}, {30})

    def test_pedestrian_ignores_motor_vehicle_turn_restriction(self) -> None:
        network = RoadNetwork(network_fixture())
        outgoing = network.allowed_outgoing(network.edges_by_id["a-f"], "pedestrian")
        self.assertEqual({edge.way_id for edge in outgoing}, {20, 30})

    def test_motorcar_exception_disables_turn_restriction(self) -> None:
        fixture = network_fixture()
        fixture["restrictions"][0]["except"] = ["motorcar", "bus"]
        network = RoadNetwork(fixture)
        outgoing = network.allowed_outgoing(network.edges_by_id["a-f"], "car")
        self.assertEqual({edge.way_id for edge in outgoing}, {20, 30})

    def test_turn_lanes_select_matching_lane(self) -> None:
        network = RoadNetwork(network_fixture())
        incoming = network.edges_by_id["a-f"]
        straight = network.edges_by_id["b-f"]
        left = network.edges_by_id["c-f"]
        self.assertEqual(network.lane_options_for_turn(incoming, straight), (1,))
        self.assertEqual(network.lane_options_for_turn(incoming, left), (0,))

    def test_via_way_restriction_uses_way_history(self) -> None:
        fixture = network_fixture()
        fixture["nodes"].extend(
            [
                {"id": 5, "lat": 47.481, "lng": 19.04},
                {"id": 6, "lat": 47.48, "lng": 19.05},
            ]
        )
        fixture["edges"].extend(
            [
                {
                    "id": "d-f",
                    "segmentId": "d",
                    "wayId": 40,
                    "from": 4,
                    "to": 5,
                    "modes": ["car"],
                    "lanes": 1,
                    "maxSpeedKph": 30,
                    "highway": "residential",
                },
                {
                    "id": "e-f",
                    "segmentId": "e",
                    "wayId": 50,
                    "from": 4,
                    "to": 6,
                    "modes": ["car"],
                    "lanes": 1,
                    "maxSpeedKph": 30,
                    "highway": "residential",
                },
            ]
        )
        fixture["restrictions"] = [
            {
                "id": 101,
                "restriction": "only_straight_on",
                "fromWays": [10],
                "toWays": [40],
                "viaNodes": [],
                "viaWays": [30],
                "except": [],
            }
        ]
        network = RoadNetwork(fixture)
        outgoing = network.allowed_outgoing(
            network.edges_by_id["c-f"], "car", (10, 30)
        )
        self.assertEqual({edge.way_id for edge in outgoing}, {40})
        allowed_route = network.shortest_route(1, 5, "car")
        forbidden_route = network.shortest_route(1, 6, "car")
        self.assertEqual(
            tuple(edge.id for edge in allowed_route or ()),
            ("a-f", "c-f", "d-f"),
        )
        self.assertEqual(
            tuple(edge.id for edge in forbidden_route or ()),
            ("a-f", "b-f", "b-loop", "c-f", "e-f"),
        )

    def test_shortest_route_obeys_mode_specific_edges(self) -> None:
        network = RoadNetwork(poi_routing_fixture())
        car_route = network.shortest_route(1, 3, "car")
        pedestrian_route = network.shortest_route(1, 3, "pedestrian")
        self.assertEqual(
            tuple(edge.id for edge in car_route or ()),
            ("car-12", "car-23"),
        )
        self.assertEqual(
            tuple(edge.id for edge in pedestrian_route or ()),
            ("ped-14", "ped-43"),
        )
        self.assertTrue(all("car" in edge.modes for edge in car_route or ()))
        self.assertTrue(
            all("pedestrian" in edge.modes for edge in pedestrian_route or ())
        )

    def test_pedestrian_route_prefers_footway_over_shorter_primary(self) -> None:
        fixture = {
            "meta": {},
            "nodes": [
                {"id": 1, "lat": 47.47, "lng": 19.0},
                {"id": 2, "lat": 47.47, "lng": 19.001},
                {"id": 3, "lat": 47.4704, "lng": 19.0005},
            ],
            "edges": [
                {
                    "id": "primary-forward",
                    "segmentId": "primary",
                    "wayId": 10,
                    "from": 1,
                    "to": 2,
                    "modes": ["car", "pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 100,
                    "maxSpeedKph": 50,
                    "highway": "primary",
                },
                {
                    "id": "primary-backward",
                    "segmentId": "primary",
                    "wayId": 10,
                    "from": 2,
                    "to": 1,
                    "modes": ["car", "pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 100,
                    "maxSpeedKph": 50,
                    "highway": "primary",
                },
                {
                    "id": "footway-out-forward",
                    "segmentId": "footway-out",
                    "wayId": 20,
                    "from": 1,
                    "to": 3,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 60,
                    "maxSpeedKph": 5,
                    "highway": "footway",
                },
                {
                    "id": "footway-out-backward",
                    "segmentId": "footway-out",
                    "wayId": 20,
                    "from": 3,
                    "to": 1,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 60,
                    "maxSpeedKph": 5,
                    "highway": "footway",
                },
                {
                    "id": "footway-in-forward",
                    "segmentId": "footway-in",
                    "wayId": 21,
                    "from": 3,
                    "to": 2,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 60,
                    "maxSpeedKph": 5,
                    "highway": "footway",
                },
                {
                    "id": "footway-in-backward",
                    "segmentId": "footway-in",
                    "wayId": 21,
                    "from": 2,
                    "to": 3,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 60,
                    "maxSpeedKph": 5,
                    "highway": "footway",
                },
            ],
            "restrictions": [],
            "pois": [],
        }
        network = RoadNetwork(fixture)
        pedestrian_route = network.shortest_route(1, 2, "pedestrian")
        car_route = network.shortest_route(1, 2, "car")
        self.assertEqual(
            tuple(edge.id for edge in pedestrian_route or ()),
            ("footway-out-forward", "footway-in-forward"),
        )
        self.assertEqual(
            tuple(edge.id for edge in car_route or ()),
            ("primary-forward",),
        )

    def test_shortest_route_obeys_turn_restriction(self) -> None:
        network = RoadNetwork(network_fixture())
        car_route = network.shortest_route(1, 3, "car")
        pedestrian_route = network.shortest_route(1, 3, "pedestrian")
        self.assertEqual(
            tuple(edge.id for edge in car_route or ()),
            ("a-f", "c-f", "c-loop", "b-f"),
        )
        self.assertEqual(
            tuple(edge.id for edge in pedestrian_route or ()),
            ("a-f", "b-f"),
        )

    def test_car_route_does_not_use_dead_end_as_u_turn_manoeuvre(self) -> None:
        fixture = {
            "meta": {},
            "nodes": [
                {"id": node_id, "lat": 47.47, "lng": 19.04}
                for node_id in range(1, 6)
            ],
            "edges": [
                {
                    "id": edge_id,
                    "segmentId": segment_id,
                    "wayId": way_id,
                    "from": from_node,
                    "to": to_node,
                    "modes": ["car", "pedestrian"],
                    "lanes": 1,
                    "lengthMeters": length,
                    "maxSpeedKph": 30,
                    "highway": "residential",
                }
                for edge_id, segment_id, way_id, from_node, to_node, length in (
                    ("approach", "approach", 10, 1, 2, 1),
                    ("dead-end-in", "dead-end", 20, 2, 3, 1),
                    ("dead-end-out", "dead-end", 20, 3, 2, 1),
                    ("restricted-shortcut", "shortcut", 30, 2, 4, 1),
                    ("detour-out", "detour-out", 40, 2, 5, 10),
                    ("detour-in", "detour-in", 50, 5, 4, 10),
                )
            ],
            "restrictions": [
                {
                    "id": 200,
                    "restriction": "no_right_turn",
                    "fromWays": [10],
                    "toWays": [30],
                    "viaNodes": [2],
                    "viaWays": [],
                    "except": [],
                }
            ],
            "pois": [],
        }
        network = RoadNetwork(fixture)

        dead_end_in = network.edges_by_id["dead-end-in"]
        self.assertEqual(
            tuple(
                edge.id
                for edge in network.allowed_outgoing(dead_end_in, "car")
            ),
            ("dead-end-out",),
        )
        self.assertEqual(
            network.allowed_outgoing(
                dead_end_in,
                "car",
                allow_forced_u_turn=False,
            ),
            (),
        )

        route = network.shortest_route(1, 4, "car")
        self.assertEqual(
            tuple(edge.id for edge in route or ()),
            ("approach", "detour-out", "detour-in"),
        )

    def test_pois_snap_to_nodes_available_for_each_mode(self) -> None:
        network = RoadNetwork(poi_routing_fixture())
        poi = network.pois[0]
        self.assertEqual(network.nearest_node(poi.latitude, poi.longitude, "car"), 1)
        self.assertEqual(
            network.nearest_node(poi.latitude, poi.longitude, "pedestrian"), 1
        )

    def test_simulation_graph_excludes_inappropriate_road_types(self) -> None:
        fixture = poi_routing_fixture()
        fixture["nodes"].extend(
            [
                {"id": 50, "lat": 47.01, "lng": 19.01},
                {"id": 51, "lat": 47.0101, "lng": 19.01},
            ]
        )
        fixture["edges"].extend(
            [
                {
                    "id": "ped-corridor-shortcut",
                    "segmentId": "ped-corridor-shortcut",
                    "wayId": 300,
                    "from": 1,
                    "to": 3,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 1,
                    "maxSpeedKph": 5,
                    "highway": "corridor",
                },
                {
                    "id": "ped-platform-shortcut",
                    "segmentId": "ped-platform-shortcut",
                    "wayId": 301,
                    "from": 3,
                    "to": 1,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 1,
                    "maxSpeedKph": 5,
                    "highway": "platform",
                },
                {
                    "id": "car-footway-shortcut",
                    "segmentId": "car-footway-shortcut",
                    "wayId": 302,
                    "from": 1,
                    "to": 3,
                    "modes": ["car"],
                    "lanes": 1,
                    "lengthMeters": 1,
                    "maxSpeedKph": 5,
                    "highway": "footway",
                },
                {
                    "id": "isolated-footway-forward",
                    "segmentId": "isolated-footway",
                    "wayId": 303,
                    "from": 50,
                    "to": 51,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 12,
                    "maxSpeedKph": 5,
                    "highway": "footway",
                },
                {
                    "id": "isolated-footway-backward",
                    "segmentId": "isolated-footway",
                    "wayId": 303,
                    "from": 51,
                    "to": 50,
                    "modes": ["pedestrian"],
                    "lanes": 1,
                    "lengthMeters": 12,
                    "maxSpeedKph": 5,
                    "highway": "footway",
                },
            ]
        )
        network = RoadNetwork(fixture)
        pedestrian_ids = {edge.id for edge in network.edges_by_mode["pedestrian"]}
        car_ids = {edge.id for edge in network.edges_by_mode["car"]}
        self.assertNotIn("ped-corridor-shortcut", pedestrian_ids)
        self.assertNotIn("ped-platform-shortcut", pedestrian_ids)
        self.assertNotIn("isolated-footway-forward", pedestrian_ids)
        self.assertNotIn("car-footway-shortcut", car_ids)
        pedestrian_route = network.shortest_route(1, 3, "pedestrian")
        self.assertEqual(
            tuple(edge.id for edge in pedestrian_route or ()),
            ("ped-14", "ped-43"),
        )

    def test_snap_uses_weighted_road_preference_and_distance_limit(self) -> None:
        fixture = geographic_poi_fixture()
        fixture["nodes"].extend(
            [
                {"id": 100, "lat": 47.43, "lng": 19.00005},
                {"id": 101, "lat": 47.4301, "lng": 19.00005},
            ]
        )
        fixture["edges"].extend(
            [
                {
                    "id": "tertiary-forward",
                    "segmentId": "tertiary",
                    "wayId": 9_000,
                    "from": 100,
                    "to": 101,
                    "modes": ["car"],
                    "lanes": 1,
                    "lengthMeters": 12,
                    "maxSpeedKph": 30,
                    "highway": "tertiary",
                },
                {
                    "id": "tertiary-backward",
                    "segmentId": "tertiary",
                    "wayId": 9_000,
                    "from": 101,
                    "to": 100,
                    "modes": ["car"],
                    "lanes": 1,
                    "lengthMeters": 12,
                    "maxSpeedKph": 30,
                    "highway": "tertiary",
                },
            ]
        )
        network = RoadNetwork(fixture)
        snapped = network.nearest_node(
            47.43,
            19.00005,
            "car",
            max_distance_meters=200,
            prefer_suitable_highway=True,
        )
        self.assertEqual(snapped, 1)
        self.assertIsNone(
            network.nearest_node(
                48.0,
                20.0,
                "car",
                max_distance_meters=50,
                prefer_suitable_highway=True,
            )
        )


class NetworkSimulationTests(unittest.TestCase):
    def test_agents_move_on_fixed_network(self) -> None:
        simulation = NetworkTrafficSimulation(
            network_fixture(), cars=20, pedestrians=30, seed=4
        )
        simulation.step(1)
        stats = simulation.stats()
        self.assertEqual(stats["cars"], 20)
        self.assertEqual(stats["pedestrians"], 30)
        self.assertGreater(stats["averageCarSpeedKph"], 0)
        self.assertEqual(len(simulation.snapshot()["agents"]), 50)

    def test_segment_statistics_track_recent_car_flow_and_reset(self) -> None:
        simulation = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=1, pedestrians=0, seed=17
        )
        for _ in range(20):
            simulation.step(0.5)

        payload = simulation.segment_statistics()
        self.assertEqual(payload["windowSeconds"], 60.0)
        self.assertTrue(payload["segments"])
        self.assertGreater(
            sum(record[0] for record in payload["segments"].values()),
            0,
        )
        self.assertTrue(
            any(record[5] > 0 for record in payload["segments"].values())
        )
        for record in payload["segments"].values():
            self.assertGreaterEqual(record[4], 0)
            self.assertLessEqual(record[4], 100)

        segment_id = next(iter(payload["segments"]))
        detail = simulation.segment_statistics(segment_id=segment_id)
        self.assertEqual(set(detail["segments"]), {segment_id})

        simulation.reset()
        reset_detail = simulation.segment_statistics(segment_id=segment_id)
        self.assertEqual(reset_detail["segments"][segment_id][0], 0)
        self.assertEqual(reset_detail["segments"][segment_id][5], 0)

    def test_population_resize_and_reset(self) -> None:
        simulation = NetworkTrafficSimulation(
            network_fixture(), cars=5, pedestrians=8, seed=5
        )
        simulation.set_agent_targets(cars=2, pedestrians=3)
        self.assertEqual(simulation.stats()["cars"], 2)
        self.assertEqual(simulation.stats()["pedestrians"], 3)
        simulation.step(5)
        simulation.reset()
        self.assertEqual(simulation.stats()["elapsedSeconds"], 0)

    def test_agents_follow_poi_routes_and_report_trip_endpoints(self) -> None:
        simulation = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=1, pedestrians=1, seed=17
        )
        initial_state = simulation.snapshot()
        self.assertEqual(initial_state["stats"]["activeTrips"], 2)
        self.assertEqual(set(initial_state["routing"]), {"car", "pedestrian"})
        self.assertGreater(initial_state["routing"]["car"]["viableAnchors"], 0)
        for agent in initial_state["agents"]:
            self.assertEqual(
                set(agent["originPoi"]),
                {"id", "name", "category", "kind", "snapDistanceMeters"},
            )
            self.assertEqual(
                set(agent["destinationPoi"]),
                {"id", "name", "category", "kind", "snapDistanceMeters"},
            )

        simulation.step(120)
        self.assertGreaterEqual(simulation.stats()["completedTrips"], 2)
        for agent in simulation.agents:
            self.assertIn(agent.mode, agent.edge.modes)

    def test_selected_agent_snapshot_contains_complete_route_geometry(self) -> None:
        simulation = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=1, pedestrians=1, seed=17
        )
        agent = simulation.agents[0]
        self.assertTrue(agent.route_edge_ids)

        ordinary_snapshot = simulation.snapshot()
        self.assertNotIn("selectedRoute", ordinary_snapshot)

        selected_snapshot = simulation.snapshot(selected_agent_id=agent.id)
        selected_route = selected_snapshot["selectedRoute"]
        self.assertIsNotNone(selected_route)
        self.assertEqual(selected_route["agentId"], agent.id)
        self.assertEqual(selected_route["mode"], agent.mode)
        self.assertEqual(selected_route["routeIndex"], agent.route_index)
        self.assertIsInstance(selected_route["token"], str)
        self.assertTrue(selected_route["token"])

        first_edge = simulation.network.edges_by_id[agent.route_edge_ids[0]]
        expected_node_ids = [
            first_edge.from_node,
            *(
                simulation.network.edges_by_id[edge_id].to_node
                for edge_id in agent.route_edge_ids
            ),
        ]
        self.assertEqual(selected_route["nodeIds"], expected_node_ids)

    def test_known_selected_route_token_omits_unchanged_node_ids(self) -> None:
        simulation = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=1, pedestrians=0, seed=21
        )
        agent = simulation.agents[0]
        first_route = simulation.snapshot(selected_agent_id=agent.id)["selectedRoute"]

        unchanged_route = simulation.snapshot(
            selected_agent_id=agent.id,
            known_route_token=first_route["token"],
        )["selectedRoute"]

        self.assertEqual(
            unchanged_route,
            {
                "agentId": agent.id,
                "mode": agent.mode,
                "token": first_route["token"],
                "routeIndex": agent.route_index,
            },
        )
        self.assertNotIn("nodeIds", unchanged_route)

    def test_unknown_selected_agent_has_null_route(self) -> None:
        simulation = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=1, pedestrians=1, seed=17
        )
        unknown_id = max(agent.id for agent in simulation.agents) + 1

        snapshot = simulation.snapshot(selected_agent_id=unknown_id)

        self.assertIn("selectedRoute", snapshot)
        self.assertIsNone(snapshot["selectedRoute"])

    def test_compact_agent_records_match_the_legacy_snapshot_precision(self) -> None:
        simulation = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=2, pedestrians=2, seed=17
        )
        legacy_agents = {
            agent["id"]: agent for agent in simulation.snapshot()["agents"]
        }
        compact_agents = simulation.compact_agent_records()
        self.assertEqual(set(compact_agents), set(legacy_agents))
        for agent_id, record in compact_agents.items():
            legacy = legacy_agents[agent_id]
            self.assertEqual(len(record), 6)
            self.assertEqual(record[0], 0 if legacy["mode"] == "car" else 1)
            self.assertEqual(record[1], round(legacy["lat"] * 10_000_000))
            self.assertEqual(record[2], round(legacy["lng"] * 10_000_000))
            self.assertEqual(record[3], round(legacy["heading"] * 10))
            self.assertEqual(record[4], int(legacy["waiting"]))
            self.assertEqual(record[5], 0)

        legacy_size = len(json.dumps(list(legacy_agents.values()), separators=(",", ":")))
        compact_size = len(
            json.dumps(
                [(agent_id, *record) for agent_id, record in compact_agents.items()],
                separators=(",", ":"),
            )
        )
        self.assertLess(compact_size, legacy_size * 0.4)

        selected_id = next(iter(compact_agents))
        selected_details = simulation.compact_selected_agent(selected_id)
        self.assertIsNotNone(selected_details)
        legacy_selected = legacy_agents[selected_id]
        self.assertEqual(selected_details[0], selected_id)
        for compact_poi, endpoint in zip(
            selected_details[1:], ("originPoi", "destinationPoi"), strict=True
        ):
            legacy_poi = legacy_selected[endpoint]
            self.assertEqual(compact_poi[:4], tuple(legacy_poi[key] for key in ("id", "name", "category", "kind")))
            self.assertEqual(compact_poi[4] / 10, legacy_poi["snapDistanceMeters"])

        relocated_agent = simulation.agents[0]
        self.assertTrue(
            simulation._restart_agent_trip(relocated_agent, prefer_gateway=False)
        )
        self.assertEqual(
            simulation.compact_agent_records()[relocated_agent.id][5],
            1,
        )

    def test_large_step_crosses_multiple_route_edges(self) -> None:
        simulation = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=1, pedestrians=0, seed=21
        )
        cached_routes = len(simulation.route_cache)
        simulation.step(120)
        self.assertGreater(simulation.stats()["completedTrips"], 1)
        self.assertEqual(simulation.stats()["activeTrips"], 1)
        self.assertEqual(len(simulation.route_cache), cached_routes)

    def test_same_seed_produces_identical_poi_trip_state(self) -> None:
        first = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=4, pedestrians=4, seed=91
        )
        second = NetworkTrafficSimulation(
            poi_routing_fixture(), cars=4, pedestrians=4, seed=91
        )
        for delta in (0.5, 3.0, 17.0):
            first.step(delta)
            second.step(delta)
        self.assertEqual(first.snapshot(), second.snapshot())

    def test_route_catalog_is_stable_across_agent_seeds(self) -> None:
        first = NetworkTrafficSimulation(
            geographic_poi_fixture(), cars=0, pedestrians=0, seed=1
        )
        second = NetworkTrafficSimulation(
            geographic_poi_fixture(), cars=0, pedestrians=0, seed=999
        )
        for mode in ("car", "pedestrian"):
            first_pairs = {
                origin_id: tuple(destination.poi.id for destination in destinations)
                for origin_id, destinations in first.route_successors[mode].items()
            }
            second_pairs = {
                origin_id: tuple(destination.poi.id for destination in destinations)
                for origin_id, destinations in second.route_successors[mode].items()
            }
            self.assertEqual(first_pairs, second_pairs)

    def test_exported_route_catalog_loads_without_rebuilding(self) -> None:
        fixture = geographic_poi_fixture()
        built = NetworkTrafficSimulation(
            fixture, cars=0, pedestrians=0, seed=1
        )
        catalog = built.export_route_catalog()
        loaded = NetworkTrafficSimulation(
            fixture,
            cars=2,
            pedestrians=2,
            seed=1,
            route_catalog=catalog,
        )
        self.assertTrue(loaded.route_catalog_loaded)
        self.assertEqual(
            {
                key: value
                for key, value in built.route_cache.items()
                if value
            },
            loaded.route_cache,
        )
        for mode in ("car", "pedestrian"):
            self.assertEqual(
                {
                    origin_id: tuple(
                        destination.poi.id for destination in destinations
                    )
                    for origin_id, destinations in built.route_successors[mode].items()
                },
                {
                    origin_id: tuple(
                        destination.poi.id for destination in destinations
                    )
                    for origin_id, destinations in loaded.route_successors[mode].items()
                },
            )
        self.assertEqual(loaded.stats()["activeTrips"], 4)

    def test_dead_end_does_not_teleport_agent(self) -> None:
        fixture = poi_routing_fixture()
        fixture["edges"] = [
            {
                "id": "dead-end",
                "segmentId": "dead-end",
                "wayId": 999,
                "from": 1,
                "to": 2,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "lengthMeters": 10,
                "maxSpeedKph": 30,
                "highway": "service",
            }
        ]
        fixture["pois"] = []
        simulation = NetworkTrafficSimulation(
            fixture, cars=1, pedestrians=0, seed=3
        )
        simulation.step(120)
        agent = simulation.agents[0]
        self.assertEqual(agent.edge.id, "dead-end")
        self.assertEqual(agent.distance_meters, agent.edge.length_meters)

    def test_od_anchors_are_geographically_diverse_and_skip_micro_pois(self) -> None:
        simulation = NetworkTrafficSimulation(
            geographic_poi_fixture(), cars=2, pedestrians=2, seed=31
        )
        for mode in ("car", "pedestrian"):
            anchors = simulation.route_pois_by_mode[mode]
            self.assertGreater(len(anchors), 16)
            self.assertGreaterEqual(
                simulation.route_selection_stats[mode]["gridCells"], 20
            )
            self.assertFalse(
                {"waste_basket", "picnic_table", "bicycle_parking"}
                & {anchor.poi.subtype for anchor in anchors}
            )

    def test_each_geographic_origin_keeps_many_successors_and_two_warm_routes(self) -> None:
        simulation = NetworkTrafficSimulation(
            geographic_poi_fixture(), cars=0, pedestrians=0, seed=37
        )
        for mode in ("car", "pedestrian"):
            anchors = simulation.route_pois_by_mode[mode]
            anchor_ids = {anchor.poi.id for anchor in anchors}
            self.assertGreater(len(anchors), 16)
            self.assertGreaterEqual(
                simulation.route_selection_stats[mode]["successorMinimum"], 4
            )
            self.assertGreaterEqual(
                simulation.route_selection_stats[mode]["warmSuccessorMinimum"],
                2,
            )
            for origin_id, destinations in simulation.route_successors[mode].items():
                self.assertIn(origin_id, anchor_ids)
                self.assertGreaterEqual(len(destinations), 4)
                self.assertEqual(
                    len({item.poi.id for item in destinations}),
                    len(destinations),
                )
                self.assertTrue(
                    all(item.poi.id in anchor_ids for item in destinations)
                )
                self.assertGreaterEqual(
                    sum(
                        bool(
                            simulation.route_cache.get(
                                (mode, origin_id, item.poi.id)
                            )
                        )
                        for item in destinations
                    ),
                    2,
                )

    def test_seeded_agents_use_more_od_pairs_than_origins(self) -> None:
        simulation = NetworkTrafficSimulation(
            geographic_poi_fixture(), cars=160, pedestrians=160, seed=43
        )
        state = simulation.snapshot()
        for mode in ("car", "pedestrian"):
            pairs = {
                (agent["originPoi"]["id"], agent["destinationPoi"]["id"])
                for agent in state["agents"]
                if agent["mode"] == mode
                and agent["originPoi"] is not None
                and agent["destinationPoi"] is not None
            }
            origins = {origin_id for origin_id, _ in pairs}
            self.assertGreater(len(pairs), len(origins))
            self.assertGreaterEqual(
                len(pairs),
                simulation.route_selection_stats[mode]["viableAnchors"] + 5,
            )

    def test_pedestrian_gateways_prefer_local_walkable_edges(self) -> None:
        fixture = geographic_poi_fixture()
        fixture["pois"] = []
        simulation = NetworkTrafficSimulation(
            fixture, cars=0, pedestrians=0, seed=47
        )
        gateways = [
            anchor
            for anchor in simulation.route_pois_by_mode["pedestrian"]
            if anchor.gateway
        ]
        self.assertEqual(len(gateways), 4)
        self.assertTrue(
            all(anchor.poi.subtype == "residential" for anchor in gateways)
        )
        self.assertEqual(
            simulation.route_selection_stats["pedestrian"]["gatewayHighways"],
            {"residential": 4},
        )

    def test_boundary_main_roads_create_gateway_trips(self) -> None:
        fixture = geographic_poi_fixture()
        fixture["pois"] = []
        for edge in fixture["edges"]:
            edge["highway"] = "primary"
        simulation = NetworkTrafficSimulation(
            fixture, cars=2, pedestrians=2, seed=41
        )
        for mode in ("car", "pedestrian"):
            anchors = simulation.route_pois_by_mode[mode]
            self.assertGreaterEqual(sum(anchor.gateway for anchor in anchors), 4)
            self.assertTrue(all(anchor.gateway for anchor in anchors))
        simulation.step(600)
        self.assertEqual(simulation.stats()["activeTrips"], 4)
        for agent in simulation.snapshot()["agents"]:
            self.assertEqual(agent["originPoi"]["kind"], "gateway")
            self.assertEqual(agent["destinationPoi"]["kind"], "gateway")
            self.assertEqual(agent["originPoi"]["snapDistanceMeters"], 0.0)

    def test_major_landmarks_survive_dense_poi_selection(self) -> None:
        fixture = geographic_poi_fixture()
        node_by_id = {node["id"]: node for node in fixture["nodes"]}
        landmarks = (
            (
                "node/70001",
                1,
                "Kelenföld vasútállomás",
                "transit",
                "station",
                ["pedestrian"],
                "node",
            ),
            (
                "relation/70002",
                13,
                "Bikás park",
                "leisure",
                "park",
                ["car", "pedestrian"],
                "relation",
            ),
            (
                "way/70003",
                25,
                "Etele Plaza",
                "shopping",
                "mall",
                ["car", "pedestrian"],
                "way",
            ),
        )
        for poi_id, node_id, name, category, subtype, modes, osm_type in landmarks:
            node = node_by_id[node_id]
            fixture["pois"].append(
                {
                    "id": poi_id,
                    "osmType": osm_type,
                    "osmId": int(poi_id.split("/")[1]),
                    "lat": node["lat"],
                    "lng": node["lng"],
                    "name": name,
                    "category": category,
                    "subtype": subtype,
                    "tags": {"name": name, category: subtype},
                    "tripModes": modes,
                    "weight": 2,
                }
            )

        simulation = NetworkTrafficSimulation(
            fixture, cars=0, pedestrians=0, seed=53
        )
        car_names = {
            anchor.poi.name for anchor in simulation.route_pois_by_mode["car"]
        }
        pedestrian_names = {
            anchor.poi.name
            for anchor in simulation.route_pois_by_mode["pedestrian"]
        }
        self.assertTrue(
            {"Kelenföld vasútállomás", "Bikás park", "Etele Plaza"}
            <= car_names
        )
        self.assertTrue(
            {"Kelenföld vasútállomás", "Bikás park", "Etele Plaza"}
            <= pedestrian_names
        )

    def test_directed_boundary_tails_create_source_and_sink_portals(self) -> None:
        fixture = geographic_poi_fixture()
        fixture["nodes"].extend(
            [
                {"id": 101, "lat": 47.43, "lng": 18.996},
                {"id": 102, "lat": 47.43, "lng": 18.998},
                {"id": 103, "lat": 47.434, "lng": 19.006},
                {"id": 104, "lat": 47.434, "lng": 19.008},
            ]
        )
        for edge_id, from_node, to_node in (
            ("motorway-entry-a", 101, 102),
            ("motorway-entry-b", 102, 1),
            ("bridge-exit-a", 25, 103),
            ("bridge-exit-b", 103, 104),
        ):
            fixture["edges"].append(
                {
                    "id": edge_id,
                    "segmentId": edge_id,
                    "wayId": 80_000 + len(fixture["edges"]),
                    "from": from_node,
                    "to": to_node,
                    "modes": ["car"],
                    "lanes": 2,
                    "lengthMeters": 150,
                    "maxSpeedKph": 90,
                    "highway": "motorway",
                }
            )

        simulation = NetworkTrafficSimulation(
            fixture, cars=1, pedestrians=0, seed=59
        )
        gateways = [
            anchor
            for anchor in simulation.route_pois_by_mode["car"]
            if anchor.gateway
        ]
        source = next(
            anchor
            for anchor in gateways
            if anchor.portal_role == "source" and anchor.node_id == 101
        )
        sink = next(
            anchor
            for anchor in gateways
            if anchor.portal_role == "sink" and anchor.node_id == 104
        )
        self.assertTrue(source.can_start_trip)
        self.assertFalse(source.can_end_trip)
        self.assertFalse(sink.can_start_trip)
        self.assertTrue(sink.can_end_trip)
        self.assertIn(source.poi.id, simulation.route_successors["car"])
        self.assertNotIn(sink.poi.id, simulation.route_successors["car"])
        self.assertIsNotNone(
            simulation.network.shortest_route(source.node_id, 13, "car")
        )
        self.assertIsNotNone(
            simulation.network.shortest_route(13, sink.node_id, "car")
        )

        agent = simulation.agents[0]
        agent.destination_poi = sink.poi
        self.assertTrue(simulation._complete_poi_trip(agent))
        self.assertEqual(simulation.gateway_exits, 1)
        self.assertEqual(simulation.gateway_entries, 1)
        self.assertEqual(agent.origin_poi_kind, "gateway")
        self.assertNotEqual(agent.origin_poi.id, sink.poi.id)


if __name__ == "__main__":
    unittest.main()
