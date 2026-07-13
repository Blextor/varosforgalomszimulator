from __future__ import annotations

import time
import unittest

from traffic_simulator import Route, TrafficSimulation, haversine_distance


CAR_ROUTE = {
    "id": "car-test",
    "name": "Autós tesztút",
    "mode": "car",
    "points": [
        {"lat": 47.47, "lng": 19.03},
        {"lat": 47.47, "lng": 19.04},
        {"lat": 47.48, "lng": 19.04},
    ],
    "durationSeconds": 120,
}

PEDESTRIAN_ROUTE = {
    "id": "ped-test",
    "name": "Gyalogos tesztút",
    "mode": "pedestrian",
    "points": [
        {"lat": 47.475, "lng": 19.04},
        {"lat": 47.477, "lng": 19.043},
    ],
    "durationSeconds": 220,
}


class RouteTests(unittest.TestCase):
    def test_haversine_distance_is_realistic_in_budapest(self) -> None:
        distance = haversine_distance((47.47, 19.03), (47.471, 19.03))
        self.assertGreater(distance, 110)
        self.assertLess(distance, 112)

    def test_route_builds_distances_capacity_and_signals(self) -> None:
        route = Route.from_payload(CAR_ROUTE)
        self.assertEqual(len(route.cumulative_distances), len(CAR_ROUTE["points"]))
        self.assertGreater(route.path_length_meters, 1_800)
        self.assertGreaterEqual(route.capacity, 5)
        self.assertGreaterEqual(len(route.signal_positions), 2)

    def test_position_interpolates_inside_segment(self) -> None:
        route = Route.from_payload(
            {
                **PEDESTRIAN_ROUTE,
                "points": [
                    {"lat": 47.47, "lng": 19.03},
                    {"lat": 47.47, "lng": 19.04},
                ],
            }
        )
        latitude, longitude, heading = route.position_at(
            route.path_length_meters / 2
        )
        self.assertAlmostEqual(latitude, 47.47, places=8)
        self.assertAlmostEqual(longitude, 19.035, places=6)
        self.assertGreater(heading, 80)
        self.assertLess(heading, 100)


class SimulationTests(unittest.TestCase):
    def test_agent_population_can_be_resized(self) -> None:
        simulation = TrafficSimulation(
            [CAR_ROUTE, PEDESTRIAN_ROUTE], cars=12, pedestrians=18, seed=42
        )
        self.assertEqual(simulation.stats()["cars"], 12)
        self.assertEqual(simulation.stats()["pedestrians"], 18)

        simulation.set_agent_targets(cars=5, pedestrians=7)
        self.assertEqual(simulation.stats()["cars"], 5)
        self.assertEqual(simulation.stats()["pedestrians"], 7)
        self.assertEqual(len({agent.id for agent in simulation.agents}), 12)

    def test_density_slows_cars(self) -> None:
        sparse = TrafficSimulation(
            [CAR_ROUTE, PEDESTRIAN_ROUTE], cars=2, pedestrians=0, seed=8
        )
        dense = TrafficSimulation(
            [CAR_ROUTE, PEDESTRIAN_ROUTE], cars=80, pedestrians=0, seed=8
        )
        sparse.step(1)
        dense.step(1)
        sparse_stats = sparse.stats()
        dense_stats = dense.stats()
        self.assertGreater(sparse_stats["averageCarSpeedKph"], 0)
        self.assertLess(
            dense_stats["averageCarSpeedKph"], sparse_stats["averageCarSpeedKph"]
        )
        self.assertGreater(
            dense_stats["congestionPercent"], sparse_stats["congestionPercent"]
        )

    def test_trips_finish_during_longer_run(self) -> None:
        simulation = TrafficSimulation(
            [CAR_ROUTE, PEDESTRIAN_ROUTE], cars=4, pedestrians=4, seed=100
        )
        for _ in range(120):
            simulation.step(10)
        self.assertGreater(simulation.stats()["completedTrips"], 0)
        self.assertEqual(len(simulation.snapshot()["agents"]), 8)

    def test_one_thousand_agents_step_and_serialize_quickly(self) -> None:
        simulation = TrafficSimulation(
            [CAR_ROUTE, PEDESTRIAN_ROUTE], cars=500, pedestrians=500, seed=7
        )
        started = time.perf_counter()
        for _ in range(60):
            simulation.step(0.5)
        snapshot = simulation.snapshot()
        elapsed = time.perf_counter() - started
        self.assertEqual(len(snapshot["agents"]), 1_000)
        self.assertLess(elapsed, 3.0)


if __name__ == "__main__":
    unittest.main()
