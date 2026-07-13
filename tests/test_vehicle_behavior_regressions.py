from __future__ import annotations

import unittest
from random import Random

from traffic_simulator.network_simulation import (
    CAR_LENGTH_METERS,
    NetworkAgent,
    NetworkPOI,
    NetworkTrafficSimulation,
    RoadNetwork,
)


def _edge(
    edge_id: str,
    way_id: int,
    from_node: int,
    to_node: int,
    *,
    lanes: int = 1,
    length_meters: float = 200.0,
    turn_lanes: list[list[str]] | None = None,
) -> dict:
    payload = {
        "id": edge_id,
        "segmentId": f"{edge_id}-segment",
        "wayId": way_id,
        "from": from_node,
        "to": to_node,
        "modes": ["car", "pedestrian"],
        "lanes": lanes,
        "direction": "forward",
        "lengthMeters": length_meters,
        "maxSpeedKph": 50,
        "highway": "primary",
    }
    if turn_lanes is not None:
        payload["turnLanes"] = turn_lanes
    return payload


def vehicle_behavior_network_fixture() -> dict:
    """Small strongly connected graph exercising lanes, signals and transitions."""

    return {
        "meta": {
            "bounds": {
                "south": 47.469,
                "west": 19.030,
                "north": 47.471,
                "east": 19.037,
            }
        },
        "nodes": [
            {"id": 1, "lat": 47.4700, "lng": 19.0300},
            {"id": 2, "lat": 47.4700, "lng": 19.0310, "trafficSignal": True},
            {"id": 3, "lat": 47.4700, "lng": 19.0320},
            {"id": 4, "lat": 47.4710, "lng": 19.0310},
            {"id": 5, "lat": 47.4690, "lng": 19.0310},
            {"id": 6, "lat": 47.4700, "lng": 19.0330},
            {"id": 7, "lat": 47.4700, "lng": 19.0340},
            {"id": 8, "lat": 47.4695, "lng": 19.0340},
            {"id": 9, "lat": 47.4695, "lng": 19.0350},
            {"id": 10, "lat": 47.4695, "lng": 19.0360},
            {"id": 11, "lat": 47.4695, "lng": 19.0370},
        ],
        "segments": [],
        "edges": [
            _edge(
                "approach",
                10,
                1,
                2,
                lanes=3,
                turn_lanes=[
                    ["left", "through"],
                    ["through"],
                    ["right"],
                ],
            ),
            _edge("straight", 10, 2, 3, lanes=3),
            _edge("straight-next", 10, 3, 6, lanes=3),
            _edge("narrow", 10, 6, 7, lanes=1),
            _edge("connector", 40, 7, 8),
            _edge("transition-source", 50, 8, 9, length_meters=100.0),
            _edge("transition-target", 50, 9, 10),
            _edge("transition-exit", 50, 10, 11),
            _edge("return", 60, 11, 1),
            _edge("left", 20, 2, 4, lanes=2),
            _edge("left-return", 21, 4, 1, lanes=2),
            _edge("right", 30, 2, 5, lanes=2),
            _edge("right-return", 31, 5, 1, lanes=2),
        ],
        "restrictions": [],
        "pois": [],
    }


def make_car(
    agent_id: int,
    edge,
    *,
    distance_meters: float,
    lane_index: int = 0,
    desired_speed_mps: float = 20.0,
    planned_edge_id: str | None = None,
    route_edge_ids: tuple[str, ...] = (),
    route_index: int = 0,
) -> NetworkAgent:
    return NetworkAgent(
        id=agent_id,
        mode="car",
        edge=edge,
        distance_meters=distance_meters,
        desired_speed_mps=desired_speed_mps,
        current_speed_mps=0.0,
        lane_index=lane_index,
        planned_edge_id=planned_edge_id,
        way_history=(edge.way_id,),
        route_edge_ids=route_edge_ids,
        route_index=route_index,
    )


class NaturalLaneBehaviorRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.network = RoadNetwork(vehicle_behavior_network_fixture())
        self.simulation = NetworkTrafficSimulation(
            self.network,
            cars=0,
            pedestrians=0,
            seed=42,
        )

    def test_compatible_straight_route_keeps_the_current_lane(self) -> None:
        approach = self.network.edges_by_id["approach"]
        car = make_car(
            1,
            approach,
            distance_meters=25.0,
            lane_index=1,
            route_edge_ids=("approach", "straight", "straight-next"),
        )
        # Make the old random-choice implementation deterministically choose
        # lane zero from the two compatible through lanes.
        self.simulation.random = Random(1)

        for _ in range(8):
            self.simulation._plan_next(car)
            self.assertEqual(car.planned_edge_id, "straight")
            self.assertEqual(
                car.lane_index,
                1,
                "A kompatibilis jelenlegi savot nem szabad ujratervezeskor "
                "veletlenszeruen elhagyni.",
            )

    def test_turn_lane_requirement_can_force_a_lane_change(self) -> None:
        approach = self.network.edges_by_id["approach"]
        car = make_car(
            2,
            approach,
            distance_meters=25.0,
            lane_index=1,
            route_edge_ids=("approach", "left"),
        )

        self.simulation._plan_next(car)

        self.assertEqual(car.planned_edge_id, "left")
        self.assertEqual(car.lane_index, 0)

    def test_narrower_target_edge_can_force_a_lane_change(self) -> None:
        source = self.network.edges_by_id["straight-next"]
        car = make_car(
            3,
            source,
            distance_meters=source.length_meters,
            lane_index=2,
            planned_edge_id="narrow",
            route_edge_ids=("straight-next", "narrow"),
        )

        entered = self.simulation._enter_next_edge(car)

        self.assertTrue(entered)
        self.assertEqual(car.edge.id, "narrow")
        self.assertEqual(car.lane_index, 0)

    def test_occupied_compatible_entry_lane_does_not_cause_weaving(self) -> None:
        source = self.network.edges_by_id["approach"]
        target = self.network.edges_by_id["straight"]
        car = make_car(
            30,
            source,
            distance_meters=source.length_meters,
            lane_index=1,
            planned_edge_id=target.id,
            route_edge_ids=(source.id, target.id, "straight-next"),
        )
        blocker = make_car(
            31,
            target,
            distance_meters=CAR_LENGTH_METERS - 0.1,
            lane_index=1,
        )
        occupancy = {
            ("car", source.id): 1,
            ("car", target.id): 1,
        }
        lane_positions = {
            (source.id, 1): {car.id: car.distance_meters},
            (target.id, 1): {blocker.id: blocker.distance_meters},
        }

        entered = self.simulation._enter_next_edge(
            car,
            occupancy,
            lane_positions,
            {},
        )

        self.assertFalse(entered)
        self.assertEqual(car.edge.id, source.id)
        self.assertEqual(car.lane_index, 1)
        self.assertEqual(car.planned_edge_id, target.id)
        self.assertNotIn((target.id, 0), lane_positions)

    def test_compatible_lane_is_kept_after_its_entry_clears(self) -> None:
        source = self.network.edges_by_id["approach"]
        target = self.network.edges_by_id["straight"]
        car = make_car(
            32,
            source,
            distance_meters=source.length_meters,
            lane_index=1,
            planned_edge_id=target.id,
            route_edge_ids=(source.id, target.id, "straight-next"),
        )
        blocker = make_car(
            33,
            target,
            distance_meters=CAR_LENGTH_METERS,
            lane_index=1,
        )
        occupancy = {
            ("car", source.id): 1,
            ("car", target.id): 1,
        }
        lane_positions = {
            (source.id, 1): {car.id: car.distance_meters},
            (target.id, 1): {blocker.id: blocker.distance_meters},
        }

        entered = self.simulation._enter_next_edge(
            car,
            occupancy,
            lane_positions,
            {},
        )

        self.assertTrue(entered)
        self.assertEqual(car.edge.id, target.id)
        self.assertEqual(car.lane_index, 1)

    def test_final_route_edge_does_not_plan_an_unused_lane_change(self) -> None:
        approach = self.network.edges_by_id["approach"]
        car = make_car(
            4,
            approach,
            distance_meters=25.0,
            lane_index=2,
            planned_edge_id="straight",
            route_edge_ids=("approach",),
            route_index=0,
        )

        self.simulation._plan_next(car)

        self.assertIsNone(car.planned_edge_id)
        self.assertEqual(car.lane_index, 2)


class VehicleFollowingRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.network = RoadNetwork(vehicle_behavior_network_fixture())

    def new_simulation(self) -> NetworkTrafficSimulation:
        return NetworkTrafficSimulation(
            self.network,
            cars=0,
            pedestrians=0,
            seed=42,
        )

    def assert_minimum_gap(self, leader: NetworkAgent, follower: NetworkAgent) -> None:
        self.assertIs(leader.edge, follower.edge)
        self.assertEqual(leader.lane_index, follower.lane_index)
        self.assertGreaterEqual(
            leader.distance_meters - follower.distance_meters,
            CAR_LENGTH_METERS - 1e-6,
            "Az azonos savon halado autok kozeppontjai nem kerulhetnek "
            "a minimalis jarmukoznel kozelebb.",
        )

    @staticmethod
    def missing_destination() -> NetworkPOI:
        return NetworkPOI(
            id="missing-anchor",
            osm_type="node",
            osm_id=1,
            latitude=47.47,
            longitude=19.03,
            name="Teszt celpont",
            category="other",
            subtype="test",
            tags={},
            trip_modes=frozenset({"car"}),
            weight=1.0,
        )

    def test_faster_follower_cannot_overlap_a_slower_leader(self) -> None:
        edge = self.network.edges_by_id["straight"]
        for follower_first in (False, True):
            with self.subTest(follower_first=follower_first):
                simulation = self.new_simulation()
                leader = make_car(
                    1,
                    edge,
                    distance_meters=80.0,
                    lane_index=1,
                    desired_speed_mps=1.0,
                )
                follower = make_car(
                    2,
                    edge,
                    distance_meters=50.0,
                    lane_index=1,
                    desired_speed_mps=30.0,
                )
                simulation.agents = (
                    [follower, leader] if follower_first else [leader, follower]
                )

                simulation.step(2.0)

                self.assert_minimum_gap(leader, follower)

    def test_a_car_in_another_lane_does_not_block_progress(self) -> None:
        edge = self.network.edges_by_id["straight"]
        baseline = self.new_simulation()
        baseline_car = make_car(
            10,
            edge,
            distance_meters=50.0,
            lane_index=1,
            desired_speed_mps=30.0,
        )
        baseline.agents = [baseline_car]

        with_adjacent_blocker = self.new_simulation()
        free_car = make_car(
            10,
            edge,
            distance_meters=50.0,
            lane_index=1,
            desired_speed_mps=30.0,
        )
        adjacent_blocker = make_car(
            11,
            edge,
            distance_meters=65.0,
            lane_index=0,
            desired_speed_mps=0.0,
        )
        with_adjacent_blocker.agents = [adjacent_blocker, free_car]

        baseline.step(1.0)
        with_adjacent_blocker.step(1.0)

        self.assertAlmostEqual(
            free_car.distance_meters,
            baseline_car.distance_meters,
            places=9,
            msg="A szomszedos sav allo autoja nem foghatja meg a szabad savot.",
        )
        self.assertGreater(free_car.distance_meters, adjacent_blocker.distance_meters)

    def test_red_signal_builds_an_ordered_queue_behind_the_stop_line(self) -> None:
        simulation = self.new_simulation()
        approach = self.network.edges_by_id["approach"]
        cars = [
            make_car(
                agent_id,
                approach,
                distance_meters=distance,
                lane_index=1,
                desired_speed_mps=30.0,
                planned_edge_id="straight",
                route_edge_ids=("approach", "straight"),
            )
            for agent_id, distance in ((1, 185.0), (2, 175.0), (3, 165.0))
        ]
        # Exercise order independence: the rear vehicle is processed first.
        simulation.agents = [cars[2], cars[0], cars[1]]
        simulation.elapsed_seconds = 45.0

        simulation.step(2.0)

        queue = sorted(cars, key=lambda car: car.distance_meters, reverse=True)
        stop_line = approach.length_meters - 0.25
        self.assertLessEqual(queue[0].distance_meters, stop_line + 1e-6)
        for leader, follower in zip(queue, queue[1:]):
            self.assert_minimum_gap(leader, follower)

    def test_large_step_and_edge_transition_cannot_create_an_overlap(self) -> None:
        simulation = self.new_simulation()
        source = self.network.edges_by_id["transition-source"]
        target = self.network.edges_by_id["transition-target"]
        leader = make_car(
            20,
            target,
            distance_meters=20.0,
            desired_speed_mps=1.0,
            planned_edge_id="transition-exit",
            route_edge_ids=("transition-target", "transition-exit"),
        )
        follower = make_car(
            21,
            source,
            distance_meters=95.0,
            desired_speed_mps=30.0,
            planned_edge_id="transition-target",
            route_edge_ids=("transition-source", "transition-target"),
        )
        # The follower reaches the target edge early in this single, large
        # step. Its remaining time must not let it jump through the leader.
        simulation.agents = [follower, leader]

        simulation.step(3.0)

        self.assertIn(follower.edge.id, {"transition-source", "transition-target"})
        if follower.edge is target:
            route_gap = leader.distance_meters - follower.distance_meters
        else:
            # A conservative implementation may hold the follower at the end
            # of the source edge until the target edge has enough free space.
            route_gap = (
                source.length_meters
                - follower.distance_meters
                + leader.distance_meters
            )
        self.assertGreaterEqual(route_gap, CAR_LENGTH_METERS - 1e-6)

    def test_initial_car_population_has_lane_spacing(self) -> None:
        simulation = NetworkTrafficSimulation(
            self.network,
            cars=30,
            pedestrians=0,
            seed=42,
        )
        lane_groups: dict[tuple[str, int], list[float]] = {}
        for car in simulation.agents:
            lane_groups.setdefault(
                (car.edge.id, car.lane_index), []
            ).append(car.distance_meters)

        for positions in lane_groups.values():
            positions.sort(reverse=True)
            for leader, follower in zip(positions, positions[1:]):
                self.assertGreaterEqual(
                    leader - follower,
                    CAR_LENGTH_METERS - 1e-6,
                )

    def test_saturated_initial_lane_does_not_accept_the_last_failed_candidate(self) -> None:
        simulation = self.new_simulation()
        edge = self.network.edges_by_id["straight"]
        existing = make_car(1, edge, distance_meters=50.0, lane_index=1)
        simulation.agents = [existing]
        simulation._create_agent = lambda mode: make_car(
            2,
            edge,
            distance_meters=52.0,
            lane_index=1,
        )

        simulation._reconcile("car", 2)

        self.assertEqual(simulation.agents, [existing])

    def test_poi_fallback_moves_the_existing_lane_registry_entry(self) -> None:
        simulation = self.new_simulation()
        approach = self.network.edges_by_id["approach"]
        car = make_car(
            1,
            approach,
            distance_meters=approach.length_meters,
            lane_index=2,
            route_edge_ids=("approach",),
        )
        car.destination_poi = self.missing_destination()
        simulation.agents = [car]
        simulation.random = Random(1)
        occupancy = {("car", "approach"): 1}
        lane_positions = {
            ("approach", 2): {car.id: car.distance_meters},
        }

        entered = simulation._complete_poi_trip(
            car,
            occupancy,
            lane_positions,
            {},
        )

        self.assertTrue(entered)
        self.assertEqual(car.edge.id, "straight")
        self.assertNotIn(("approach", 2), lane_positions)
        self.assertEqual(
            lane_positions[(car.edge.id, car.lane_index)][car.id],
            0.0,
        )

    def test_blocked_poi_fallback_keeps_the_source_lane_registry_consistent(self) -> None:
        simulation = self.new_simulation()
        approach = self.network.edges_by_id["approach"]
        straight = self.network.edges_by_id["straight"]
        car = make_car(
            1,
            approach,
            distance_meters=approach.length_meters,
            lane_index=2,
            route_edge_ids=("approach",),
        )
        car.destination_poi = self.missing_destination()
        simulation.agents = [car]
        simulation.random = Random(1)
        occupancy = {
            ("car", "approach"): 1,
            ("car", "straight"): simulation._edge_vehicle_capacity(straight),
        }
        lane_positions = {
            ("approach", 2): {car.id: car.distance_meters},
        }

        entered = simulation._complete_poi_trip(
            car,
            occupancy,
            lane_positions,
            {},
        )

        self.assertFalse(entered)
        self.assertEqual(car.edge.id, "approach")
        self.assertEqual(car.lane_index, 2)
        self.assertEqual(car.planned_edge_id, "straight")
        self.assertEqual(
            lane_positions,
            {("approach", 2): {car.id: approach.length_meters}},
        )


if __name__ == "__main__":
    unittest.main()
