from __future__ import annotations

import unittest
from types import MethodType

from traffic_simulator.network_simulation import (
    NetworkAgent,
    NetworkTrafficSimulation,
    RoadNetwork,
)


def capacity_network_fixture() -> dict:
    """Small connected graph with a one-car short edge and a directed dead end."""

    return {
        "meta": {
            "bounds": {
                "south": 47.47,
                "west": 19.03,
                "north": 47.471,
                "east": 19.032,
            }
        },
        "nodes": [
            {"id": 1, "lat": 47.47, "lng": 19.03},
            {"id": 2, "lat": 47.47, "lng": 19.031},
            # Roughly 0.75 m from node 2, so the capacity floor is one car.
            {"id": 3, "lat": 47.47, "lng": 19.03101},
            {"id": 4, "lat": 47.47, "lng": 19.032},
            {"id": 5, "lat": 47.471, "lng": 19.03},
        ],
        "segments": [],
        "edges": [
            {
                "id": "source",
                "segmentId": "source-segment",
                "wayId": 10,
                "from": 1,
                "to": 2,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "forward",
                "maxSpeedKph": 36,
                "highway": "residential",
            },
            {
                "id": "target",
                "segmentId": "target-segment",
                "wayId": 20,
                "from": 2,
                "to": 3,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "forward",
                "maxSpeedKph": 36,
                "highway": "residential",
            },
            {
                "id": "exit",
                "segmentId": "exit-segment",
                "wayId": 30,
                "from": 3,
                "to": 4,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "forward",
                "maxSpeedKph": 36,
                "highway": "residential",
            },
            {
                "id": "loop",
                "segmentId": "loop-segment",
                "wayId": 40,
                "from": 4,
                "to": 1,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "forward",
                "maxSpeedKph": 36,
                "highway": "residential",
            },
            {
                "id": "dead-end",
                "segmentId": "dead-end-segment",
                "wayId": 50,
                "from": 1,
                "to": 5,
                "modes": ["car", "pedestrian"],
                "lanes": 1,
                "direction": "forward",
                "maxSpeedKph": 36,
                "highway": "residential",
            },
        ],
        "restrictions": [],
        "pois": [],
    }


def make_agent(
    agent_id: int,
    mode: str,
    edge,
    *,
    distance_meters: float = 0.0,
    planned_edge_id: str | None = None,
    route_edge_ids: tuple[str, ...] = (),
    route_index: int = 0,
    wait_seconds: float = 0.0,
) -> NetworkAgent:
    return NetworkAgent(
        id=agent_id,
        mode=mode,
        edge=edge,
        distance_meters=distance_meters,
        desired_speed_mps=10.0 if mode == "car" else 1.4,
        current_speed_mps=0.0,
        lane_index=0,
        planned_edge_id=planned_edge_id,
        wait_seconds=wait_seconds,
        way_history=(edge.way_id,),
        route_edge_ids=route_edge_ids,
        route_index=route_index,
    )


class NetworkCapacityRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.network = RoadNetwork(capacity_network_fixture())
        self.simulation = NetworkTrafficSimulation(
            self.network,
            cars=0,
            pedestrians=0,
            seed=42,
        )
        self.source = self.network.edges_by_id["source"]
        self.target = self.network.edges_by_id["target"]
        self.exit = self.network.edges_by_id["exit"]
        self.dead_end = self.network.edges_by_id["dead-end"]

    def install_deterministic_recovery(self) -> list[tuple[int, bool]]:
        recovery_calls: list[tuple[int, bool]] = []

        def restart_agent_trip(
            simulation: NetworkTrafficSimulation,
            agent: NetworkAgent,
            *,
            prefer_gateway: bool,
            occupancy: dict[tuple[str, str], int] | None = None,
            lane_positions: dict[
                tuple[str, int], dict[int, float]
            ] | None = None,
            following_limits: dict[int, tuple[str, int, float]] | None = None,
        ) -> bool:
            del occupancy, lane_positions, following_limits
            recovery_calls.append((agent.id, prefer_gateway))
            agent.edge = self.source
            agent.distance_meters = 0.0
            agent.planned_edge_id = self.target.id
            agent.route_edge_ids = (self.source.id, self.target.id)
            agent.route_index = 0
            agent.way_history = (self.source.way_id,)
            return True

        self.simulation._restart_agent_trip = MethodType(
            restart_agent_trip,
            self.simulation,
        )
        return recovery_calls

    def test_full_target_edge_preserves_the_waiting_cars_plan(self) -> None:
        waiting_car = make_agent(
            1,
            "car",
            self.source,
            distance_meters=self.source.length_meters,
            planned_edge_id=self.target.id,
            route_edge_ids=(self.source.id, self.target.id),
        )
        occupying_car = make_agent(
            2,
            "car",
            self.target,
            planned_edge_id=self.exit.id,
            route_edge_ids=(self.target.id, self.exit.id),
            wait_seconds=60.0,
        )
        self.simulation.agents = [waiting_car, occupying_car]

        self.simulation.step(0.01)

        self.assertIs(waiting_car.edge, self.source)
        self.assertEqual(waiting_car.planned_edge_id, self.target.id)
        self.assertAlmostEqual(waiting_car.distance_meters, self.source.length_meters)

    def test_successful_transitions_move_dynamic_mode_occupancy(self) -> None:
        leaving_car = make_agent(
            1,
            "car",
            self.target,
            distance_meters=self.target.length_meters,
            planned_edge_id=self.exit.id,
            route_edge_ids=(self.target.id, self.exit.id),
        )
        first_waiting_car = make_agent(
            2,
            "car",
            self.source,
            distance_meters=self.source.length_meters,
            planned_edge_id=self.target.id,
            route_edge_ids=(self.source.id, self.target.id),
        )
        second_waiting_car = make_agent(
            3,
            "car",
            self.source,
            distance_meters=self.source.length_meters,
            planned_edge_id=self.target.id,
            route_edge_ids=(self.source.id, self.target.id),
        )
        self.simulation.agents = [
            leaving_car,
            first_waiting_car,
            second_waiting_car,
        ]

        self.simulation.step(0.01)

        self.assertIs(leaving_car.edge, self.exit)
        self.assertIs(first_waiting_car.edge, self.source)
        self.assertIs(second_waiting_car.edge, self.source)

        # The departed target position is retained as a one-tick reservation;
        # the first queued car can enter as soon as the next context rebuilds.
        self.simulation.step(0.01)

        self.assertIs(first_waiting_car.edge, self.target)
        self.assertIs(second_waiting_car.edge, self.source)
        self.assertEqual(second_waiting_car.planned_edge_id, self.target.id)

    def test_pedestrian_occupancy_neither_blocks_nor_slows_a_car(self) -> None:
        baseline_car = make_agent(1, "car", self.source)
        baseline = NetworkTrafficSimulation(
            self.network,
            cars=0,
            pedestrians=0,
            seed=42,
        )
        baseline.agents = [baseline_car]

        crowded_car = make_agent(1, "car", self.source)
        pedestrians = [
            make_agent(
                agent_id,
                "pedestrian",
                self.source,
                wait_seconds=60.0,
            )
            for agent_id in range(2, 22)
        ]
        crowded = NetworkTrafficSimulation(
            self.network,
            cars=0,
            pedestrians=0,
            seed=42,
        )
        crowded.agents = [crowded_car, *pedestrians]

        baseline.step(0.5)
        crowded.step(0.5)

        self.assertAlmostEqual(
            crowded_car.distance_meters,
            baseline_car.distance_meters,
            places=9,
        )

        entering_car = make_agent(
            30,
            "car",
            self.source,
            distance_meters=self.source.length_meters,
            planned_edge_id=self.target.id,
            route_edge_ids=(self.source.id, self.target.id),
        )
        occupying_pedestrian = make_agent(
            31,
            "pedestrian",
            self.target,
            wait_seconds=60.0,
        )
        self.simulation.agents = [entering_car, occupying_pedestrian]

        self.simulation.step(0.01)

        self.assertIs(entering_car.edge, self.target)

    def test_invalid_route_recovers_instead_of_staying_stuck(self) -> None:
        recovery_calls = self.install_deterministic_recovery()
        invalid_plan = make_agent(
            1,
            "car",
            self.source,
            distance_meters=self.source.length_meters,
            planned_edge_id="missing-edge",
            route_edge_ids=(self.source.id, self.target.id),
        )
        self.simulation.agents = [invalid_plan]

        for _ in range(4):
            self.simulation.step(0.1)

        self.assertFalse(
            invalid_plan.edge is self.source
            and invalid_plan.distance_meters >= self.source.length_meters
            and invalid_plan.planned_edge_id is None
        )
        if invalid_plan.edge is self.source:
            self.assertTrue(recovery_calls)

    def test_dead_end_route_recovers_instead_of_staying_stuck(self) -> None:
        recovery_calls = self.install_deterministic_recovery()
        dead_end_agent = make_agent(
            2,
            "car",
            self.dead_end,
            distance_meters=self.dead_end.length_meters,
        )
        self.simulation.agents = [dead_end_agent]

        for _ in range(4):
            self.simulation.step(0.1)

        self.assertTrue(recovery_calls)
        self.assertIsNot(dead_end_agent.edge, self.dead_end)


if __name__ == "__main__":
    unittest.main()
