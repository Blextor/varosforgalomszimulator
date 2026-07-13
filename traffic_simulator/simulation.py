"""Általános, polyline-alapú tesztelhető forgalomszimulációs mag."""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from math import asin, atan2, cos, degrees, isfinite, radians, sin, sqrt
from random import Random
from typing import Any, Iterable

EARTH_RADIUS_METERS = 6_371_000.0
MAX_DELTA_SECONDS = 120.0
VALID_MODES = frozenset({"car", "pedestrian"})


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def haversine_distance(first: tuple[float, float], second: tuple[float, float]) -> float:
    """Két WGS84 koordináta közelítő távolsága méterben."""

    first_latitude, first_longitude = first
    second_latitude, second_longitude = second
    latitude_delta = radians(second_latitude - first_latitude)
    longitude_delta = radians(second_longitude - first_longitude)
    first_latitude_radians = radians(first_latitude)
    second_latitude_radians = radians(second_latitude)

    haversine = (
        sin(latitude_delta / 2) ** 2
        + cos(first_latitude_radians)
        * cos(second_latitude_radians)
        * sin(longitude_delta / 2) ** 2
    )
    return 2 * EARTH_RADIUS_METERS * asin(sqrt(haversine))


def _bearing_degrees(first: tuple[float, float], second: tuple[float, float]) -> float:
    first_latitude, first_longitude = map(radians, first)
    second_latitude, second_longitude = map(radians, second)
    longitude_delta = second_longitude - first_longitude
    x = sin(longitude_delta) * cos(second_latitude)
    y = (
        cos(first_latitude) * sin(second_latitude)
        - sin(first_latitude) * cos(second_latitude) * cos(longitude_delta)
    )
    return (degrees(atan2(x, y)) + 360) % 360


@dataclass(frozen=True, slots=True)
class Route:
    """Egy tetszőleges nyomvonal előfeldolgozott alakja."""

    id: str
    name: str
    mode: str
    points: tuple[tuple[float, float], ...]
    cumulative_distances: tuple[float, ...]
    path_length_meters: float
    reported_distance_meters: float
    duration_seconds: float
    free_flow_speed_mps: float
    capacity: int
    signal_positions: tuple[float, ...]

    @classmethod
    def from_payload(cls, payload: dict[str, Any], index: int = 0) -> Route:
        raw_points = payload.get("points")
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            raise ValueError("Egy útvonal legalább két pontból álljon.")

        mode = str(payload.get("mode", ""))
        if mode not in VALID_MODES:
            raise ValueError(f"Ismeretlen közlekedési mód: {mode}")

        points: list[tuple[float, float]] = []
        for raw_point in raw_points:
            if not isinstance(raw_point, dict):
                raise ValueError("Az útvonalpont csak koordináta-objektum lehet.")
            try:
                point = (float(raw_point["lat"]), float(raw_point["lng"]))
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError("Az útvonalpont koordinátája érvénytelen.") from error
            if not all(isfinite(coordinate) for coordinate in point):
                raise ValueError("Az útvonalpont koordinátája nem véges szám.")
            if not -90 <= point[0] <= 90 or not -180 <= point[1] <= 180:
                raise ValueError("Az útvonalpont koordinátája tartományon kívül esik.")
            points.append(point)

        cumulative_distances = [0.0]
        for first, second in zip(points, points[1:]):
            cumulative_distances.append(
                cumulative_distances[-1] + haversine_distance(first, second)
            )

        path_length = cumulative_distances[-1]
        if path_length <= 0:
            raise ValueError("Az útvonal hossza nem lehet nulla.")

        try:
            reported_distance = float(payload.get("distanceMeters", path_length))
        except (TypeError, ValueError):
            reported_distance = path_length
        if not isfinite(reported_distance) or reported_distance <= 0:
            reported_distance = path_length

        try:
            duration_seconds = float(payload.get("durationSeconds", 0))
        except (TypeError, ValueError):
            duration_seconds = 0
        if not isfinite(duration_seconds) or duration_seconds <= 0:
            duration_seconds = path_length / (10 if mode == "car" else 1.35)
        duration_seconds = max(1.0, duration_seconds)

        signal_spacing = 520 if mode == "car" else 330
        first_signal = 300 if mode == "car" else 190
        signals = tuple(
            float(distance)
            for distance in range(first_signal, int(max(first_signal, path_length - 80)), signal_spacing)
            if distance < path_length - 80
        )

        route_id = str(payload.get("id") or f"route-{index}")
        return cls(
            id=route_id,
            name=str(payload.get("name") or f"Útvonal {index + 1}"),
            mode=mode,
            points=tuple(points),
            cumulative_distances=tuple(cumulative_distances),
            path_length_meters=path_length,
            reported_distance_meters=reported_distance,
            duration_seconds=duration_seconds,
            free_flow_speed_mps=path_length / duration_seconds,
            capacity=(
                max(5, round(path_length / 280))
                if mode == "car"
                else max(8, round(path_length / 110))
            ),
            signal_positions=signals,
        )

    def position_at(self, distance_meters: float) -> tuple[float, float, float]:
        """Pozíció és haladási irány az útvonal megadott méterénél."""

        target = _clamp(distance_meters, 0.0, self.path_length_meters)
        end_index = max(1, bisect_left(self.cumulative_distances, target))
        end_index = min(end_index, len(self.points) - 1)
        start_index = end_index - 1
        segment_start = self.cumulative_distances[start_index]
        segment_length = self.cumulative_distances[end_index] - segment_start
        ratio = 0.0 if segment_length == 0 else (target - segment_start) / segment_length
        start = self.points[start_index]
        end = self.points[end_index]
        latitude = start[0] + (end[0] - start[0]) * ratio
        longitude = start[1] + (end[1] - start[1]) * ratio
        return latitude, longitude, _bearing_degrees(start, end)


@dataclass(slots=True)
class Agent:
    id: int
    mode: str
    route: Route
    distance_meters: float
    desired_speed_mps: float
    current_speed_mps: float = 0.0
    wait_seconds: float = 0.0
    next_signal_index: int = -1


class TrafficSimulation:
    """Egyszerű, sűrűségfüggő mikroszkopikus ágensszimuláció."""

    def __init__(
        self,
        routes: Iterable[Route | dict[str, Any]],
        *,
        cars: int = 60,
        pedestrians: int = 90,
        seed: int = 11_2026,
    ) -> None:
        self.routes = tuple(
            route if isinstance(route, Route) else Route.from_payload(route, index)
            for index, route in enumerate(routes)
        )
        if not self.routes:
            raise ValueError("A szimulációhoz legalább egy útvonal szükséges.")

        self.routes_by_mode = {
            mode: tuple(route for route in self.routes if route.mode == mode)
            for mode in VALID_MODES
        }
        self.seed = seed
        self.random = Random(seed)
        self.agents: list[Agent] = []
        self.elapsed_seconds = 0.0
        self.completed_trips = 0
        self.next_agent_id = 1
        self.set_agent_targets(cars=cars, pedestrians=pedestrians)

    def reset(self) -> None:
        counts = self.stats()
        self.random.seed(self.seed)
        self.agents.clear()
        self.elapsed_seconds = 0.0
        self.completed_trips = 0
        self.next_agent_id = 1
        self.set_agent_targets(
            cars=counts["cars"], pedestrians=counts["pedestrians"]
        )

    def set_agent_targets(self, *, cars: int, pedestrians: int) -> None:
        self._reconcile_mode("car", int(_clamp(int(cars), 0, 2_000)))
        self._reconcile_mode(
            "pedestrian", int(_clamp(int(pedestrians), 0, 2_000))
        )

    def _reconcile_mode(self, mode: str, target_count: int) -> None:
        routes = self.routes_by_mode[mode]
        if target_count > 0 and not routes:
            label = "autós" if mode == "car" else "gyalogos"
            raise ValueError(f"Nincs betöltött {label} útvonal.")

        existing = [agent for agent in self.agents if agent.mode == mode]
        if len(existing) > target_count:
            removable_ids = {agent.id for agent in existing[target_count:]}
            self.agents = [
                agent for agent in self.agents if agent.id not in removable_ids
            ]
            return

        for _ in range(len(existing), target_count):
            self.agents.append(self._create_agent(mode, distribute=True))

    def _create_agent(self, mode: str, *, distribute: bool) -> Agent:
        route = self.random.choice(self.routes_by_mode[mode])
        distance = self.random.random() * route.path_length_meters if distribute else 0.0
        agent_id = self.next_agent_id
        self.next_agent_id += 1
        next_signal = next(
            (
                index
                for index, signal in enumerate(route.signal_positions)
                if signal > distance
            ),
            -1,
        )
        return Agent(
            id=agent_id,
            mode=mode,
            route=route,
            distance_meters=distance,
            desired_speed_mps=(
                _clamp(
                    route.free_flow_speed_mps
                    * (0.88 + self.random.random() * 0.2),
                    4.2,
                    22.0,
                )
                if mode == "car"
                else 1.12 + self.random.random() * 0.48
            ),
            next_signal_index=next_signal,
        )

    def _choose_next_route(self, agent: Agent) -> None:
        next_route = self.random.choice(self.routes_by_mode[agent.mode])
        agent.route = next_route
        agent.distance_meters = 0.0
        agent.wait_seconds = 3 + self.random.random() * 9
        agent.next_signal_index = 0 if next_route.signal_positions else -1
        agent.desired_speed_mps = (
            _clamp(
                next_route.free_flow_speed_mps
                * (0.88 + self.random.random() * 0.2),
                4.2,
                22.0,
            )
            if agent.mode == "car"
            else 1.12 + self.random.random() * 0.48
        )

    def step(self, delta_seconds: float) -> None:
        delta = _clamp(float(delta_seconds), 0.0, MAX_DELTA_SECONDS)
        if delta == 0:
            return

        self.elapsed_seconds += delta
        occupancy: dict[str, int] = {}
        for agent in self.agents:
            occupancy[agent.route.id] = occupancy.get(agent.route.id, 0) + 1

        for agent in self.agents:
            if agent.wait_seconds > 0:
                agent.wait_seconds = max(0.0, agent.wait_seconds - delta)
                agent.current_speed_mps = 0.0
                continue

            density = occupancy.get(agent.route.id, 1) / agent.route.capacity
            overload = max(0.0, density - (0.55 if agent.mode == "car" else 0.85))
            congestion_factor = (
                1 / (1 + 0.62 * overload**1.35)
                if agent.mode == "car"
                else 1 / (1 + 0.2 * overload**1.2)
            )
            pulse = 0.96 + 0.04 * sin(self.elapsed_seconds / 19 + agent.id)
            speed = agent.desired_speed_mps * congestion_factor * pulse
            candidate_distance = agent.distance_meters + speed * delta

            if agent.next_signal_index >= 0:
                signal_distance = agent.route.signal_positions[agent.next_signal_index]
                if candidate_distance >= signal_distance:
                    cycle_seconds = 70 if agent.mode == "car" else 64
                    green_seconds = 39 if agent.mode == "car" else 31
                    phase = (
                        self.elapsed_seconds
                        + agent.next_signal_index * 13
                        + len(agent.route.id) * 3
                    ) % cycle_seconds
                    if phase >= green_seconds:
                        agent.distance_meters = max(
                            agent.distance_meters, signal_distance - 0.5
                        )
                        agent.wait_seconds = cycle_seconds - phase
                        agent.current_speed_mps = 0.0
                        continue

                    agent.next_signal_index += 1
                    if agent.next_signal_index >= len(agent.route.signal_positions):
                        agent.next_signal_index = -1

            agent.current_speed_mps = speed
            agent.distance_meters = candidate_distance
            if agent.distance_meters >= agent.route.path_length_meters:
                self.completed_trips += 1
                self._choose_next_route(agent)

    def snapshot(self) -> dict[str, Any]:
        """A Canvas klienshez szükséges tömör állapot."""

        agents = []
        for agent in self.agents:
            latitude, longitude, heading = agent.route.position_at(agent.distance_meters)
            agents.append(
                {
                    "id": agent.id,
                    "mode": agent.mode,
                    "lat": round(latitude, 7),
                    "lng": round(longitude, 7),
                    "heading": round(heading, 1),
                    "waiting": agent.wait_seconds > 0,
                }
            )
        return {"agents": agents, "stats": self.stats()}

    def stats(self) -> dict[str, int | float]:
        cars = [agent for agent in self.agents if agent.mode == "car"]
        pedestrians = [
            agent for agent in self.agents if agent.mode == "pedestrian"
        ]

        def average_speed(agents: list[Agent]) -> float:
            if not agents:
                return 0.0
            return sum(agent.current_speed_mps for agent in agents) / len(agents)

        congestion = 0.0
        if self.agents:
            congestion = sum(
                1 - agent.current_speed_mps / agent.desired_speed_mps
                for agent in self.agents
                if agent.desired_speed_mps > 0
            ) / len(self.agents)

        return {
            "cars": len(cars),
            "pedestrians": len(pedestrians),
            "averageCarSpeedKph": average_speed(cars) * 3.6,
            "averagePedestrianSpeedKph": average_speed(pedestrians) * 3.6,
            "congestionPercent": _clamp(congestion * 100, 0.0, 100.0),
            "waitingAgents": sum(agent.wait_seconds > 0 for agent in self.agents),
            "completedTrips": self.completed_trips,
            "elapsedSeconds": self.elapsed_seconds,
        }
