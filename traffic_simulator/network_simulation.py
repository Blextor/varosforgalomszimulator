"""Offline, irányított OSM úthálózaton futó forgalomszimuláció."""

from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass
from hashlib import blake2s
from heapq import heappop, heappush
from math import atan2, cos, degrees, floor, hypot, radians, sin
from random import Random
from typing import Any, Iterable

from .simulation import haversine_distance

VALID_MODES = frozenset({"car", "pedestrian"})
CAR_LENGTH_METERS = 7.5
MIN_CAR_CRAWL_FACTOR = 0.1
MIN_CAR_DENSITY_WINDOW_METERS = 40.0
SEGMENT_STAT_WINDOW_SECONDS = 60.0
LANE_WIDTH_METERS = 3.2
SPATIAL_CELL_DEGREES = 0.003
ROUTE_GRID_SIZE = 20
ROUTE_FINE_GRID_SIZE = 48
ROUTE_CATALOG_SEED = 42
ROUTE_CATALOG_VERSION = 1
MAX_ROUTE_POIS_BY_MODE = {"car": 240, "pedestrian": 260}
MAX_IMPORTANT_HOTSPOTS_BY_MODE = {"car": 64, "pedestrian": 72}
IMPORTANT_HOTSPOT_MIN_SCORE = 95.0
IMPORTANT_HOTSPOT_SEPARATION_METERS = 120.0
MAX_GATEWAYS_PER_SIDE_BY_MODE = {"car": 2, "pedestrian": 1}
MAX_ROUTE_DESTINATION_CANDIDATES = 6
ROUTE_SUCCESSORS_PER_ORIGIN = 2
MAX_WARM_ROUTE_ATTEMPTS = 4
MAX_ROUTE_CACHE_ENTRIES = 8_192
MAX_ROUTE_EXPANSIONS = 120_000
MAX_POI_SNAP_METERS = {"car": 200.0, "pedestrian": 120.0}
MIN_POI_ANCHOR_SEPARATION_METERS = 180.0
ROUTE_REUSE_PENALTY = {"car": 0.20, "pedestrian": 0.16}
MAJOR_GATEWAY_HIGHWAYS = frozenset(
    {
        "motorway",
        "motorway_link",
        "trunk",
        "trunk_link",
        "primary",
        "primary_link",
        "secondary",
        "secondary_link",
    }
)
PEDESTRIAN_GATEWAY_HIGHWAY_RANK = {
    "footway": 0,
    "path": 0,
    "pedestrian": 0,
    "cycleway": 1,
    "living_street": 1,
    "residential": 2,
    "service": 2,
    "track": 3,
    "unclassified": 3,
    "tertiary": 5,
    "secondary": 6,
    "primary": 7,
}
PEDESTRIAN_ROUTE_COST_MULTIPLIER = {
    "footway": 1.0,
    "pedestrian": 1.0,
    "path": 1.03,
    "living_street": 1.05,
    "residential": 1.08,
    "service": 1.10,
    "cycleway": 1.12,
    "unclassified": 1.18,
    "track": 1.20,
    "steps": 1.25,
    "tertiary": 1.32,
    "tertiary_link": 1.45,
    "secondary": 1.52,
    "secondary_link": 1.65,
    "primary": 1.75,
    "primary_link": 1.90,
}
PEDESTRIAN_MAJOR_HIGHWAYS = frozenset(
    {
        "primary",
        "primary_link",
        "secondary",
        "secondary_link",
        "tertiary",
        "tertiary_link",
    }
)
MODE_EXCLUDED_HIGHWAYS = {
    "car": frozenset(
        {"footway", "path", "steps", "corridor", "platform", "pedestrian"}
    ),
    "pedestrian": frozenset({"corridor", "platform"}),
}
SNAP_HIGHWAY_PRIORITY = {
    "car": {
        "residential": 0,
        "living_street": 0,
        "service": 0,
        "unclassified": 1,
        "tertiary": 1,
        "tertiary_link": 2,
        "secondary": 2,
        "secondary_link": 3,
        "primary": 3,
        "primary_link": 4,
        "trunk": 5,
        "motorway": 6,
    },
    "pedestrian": {
        "footway": 0,
        "path": 0,
        "pedestrian": 0,
        "living_street": 0,
        "residential": 1,
        "service": 1,
        "steps": 1,
        "cycleway": 2,
        "track": 2,
        "tertiary": 3,
        "secondary": 4,
        "primary": 5,
    },
}
ROUTE_POI_CATEGORIES = frozenset(
    {
        "shopping",
        "food",
        "health",
        "education",
        "service",
        "leisure",
        "parking",
        "transit",
        "other",
        "residential",
    }
)
EXCLUDED_ROUTE_POI_SUBTYPES = frozenset(
    {
        "bench",
        "waste_basket",
        "picnic_table",
        "vending_machine",
        "shelter",
        "information",
        "artwork",
        "outdoor_seating",
        "drinking_water",
        "telephone",
        "post_box",
        "recycling",
        "fountain",
        "waste_disposal",
        "parking_space",
        "parking_entrance",
        "bicycle_parking",
        "stop_position",
    }
)
ROUTE_POI_CATEGORY_ATTRACTION = {
    "transit": 16.0,
    "health": 12.0,
    "education": 10.0,
    "shopping": 8.0,
    "leisure": 7.0,
    "parking": 6.0,
    "food": 5.0,
    "service": 4.0,
    "residential": 3.0,
    "other": 1.0,
}
ROUTE_POI_SUBTYPE_ATTRACTION = {
    "station": 120.0,
    "bus_station": 112.0,
    "mall": 110.0,
    "shopping_centre": 110.0,
    "hospital": 108.0,
    "university": 104.0,
    "college": 96.0,
    "park": 92.0,
    "marketplace": 90.0,
    "stadium": 88.0,
    "sports_centre": 84.0,
    "museum": 82.0,
    "theatre": 80.0,
    "cinema": 78.0,
    "supermarket": 76.0,
    "school": 74.0,
    "clinic": 72.0,
    "community_centre": 70.0,
    "kindergarten": 68.0,
}
MAJOR_TRANSIT_CAR_DESTINATIONS = frozenset({"station", "halt", "bus_station"})


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _bearing(first: tuple[float, float], second: tuple[float, float]) -> float:
    first_latitude, first_longitude = map(radians, first)
    second_latitude, second_longitude = map(radians, second)
    longitude_delta = second_longitude - first_longitude
    x = sin(longitude_delta) * cos(second_latitude)
    y = (
        cos(first_latitude) * sin(second_latitude)
        - sin(first_latitude) * cos(second_latitude) * cos(longitude_delta)
    )
    return (degrees(atan2(x, y)) + 360) % 360


def _turn_kind(incoming_bearing: float, outgoing_bearing: float) -> str:
    delta = (outgoing_bearing - incoming_bearing + 540) % 360 - 180
    absolute_delta = abs(delta)
    if absolute_delta >= 150:
        return "reverse"
    if absolute_delta <= 32:
        return "through"
    return "right" if delta > 0 else "left"


def _turn_token_matches(tokens: tuple[str, ...], turn_kind: str) -> bool:
    if not tokens or all(token in {"", "none"} for token in tokens):
        return True
    normalized = set(tokens)
    if turn_kind == "left":
        return bool(normalized & {"left", "slight_left", "sharp_left", "merge_to_left"})
    if turn_kind == "right":
        return bool(normalized & {"right", "slight_right", "sharp_right", "merge_to_right"})
    if turn_kind == "reverse":
        return bool(normalized & {"reverse", "uturn"})
    return bool(normalized & {"through", "straight"})


@dataclass(frozen=True, slots=True)
class NetworkNode:
    id: int
    latitude: float
    longitude: float
    traffic_signal: bool = False
    crossing: bool = False


@dataclass(frozen=True, slots=True)
class NetworkEdge:
    id: str
    segment_id: str
    way_id: int
    from_node: int
    to_node: int
    modes: frozenset[str]
    lanes: int
    total_lanes: int
    direction: str
    turn_lanes: tuple[tuple[str, ...], ...]
    max_speed_kph: float
    length_meters: float
    bearing: float
    start: tuple[float, float]
    end: tuple[float, float]
    highway: str


def _edge_usable_for_mode(edge: NetworkEdge, mode: str) -> bool:
    return (
        mode in edge.modes
        and edge.highway not in MODE_EXCLUDED_HIGHWAYS.get(mode, frozenset())
    )


@dataclass(frozen=True, slots=True)
class TurnRule:
    restriction: str
    to_way_ids: frozenset[int]


@dataclass(frozen=True, slots=True)
class SequenceTurnRule:
    restriction: str
    path_way_ids: tuple[int, ...]
    to_way_ids: frozenset[int]


@dataclass(frozen=True, slots=True)
class NetworkPOI:
    id: str
    osm_type: str
    osm_id: int | str
    latitude: float
    longitude: float
    name: str
    category: str
    subtype: str
    tags: dict[str, str]
    trip_modes: frozenset[str]
    weight: float
    has_name: bool = False

    def summary(
        self,
        *,
        snap_distance_meters: float = 0.0,
        kind: str = "poi",
    ) -> dict[str, str | float]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "kind": kind,
            "snapDistanceMeters": round(max(0.0, snap_distance_meters), 1),
        }


@dataclass(frozen=True, slots=True)
class SnappedPOI:
    poi: NetworkPOI
    node_id: int
    snap_distance_meters: float = 0.0
    gateway: bool = False
    portal_role: str = "both"
    corridor_id: str = ""
    branch_depth_meters: float = 0.0

    @property
    def can_start_trip(self) -> bool:
        return not self.gateway or self.portal_role in {"source", "both"}

    @property
    def can_end_trip(self) -> bool:
        return not self.gateway or self.portal_role in {"sink", "both"}


class RoadNetwork:
    """A feldolgozott OSM JSON gyors szimulációs reprezentációja."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.meta = payload.get("meta", {})
        self.nodes = self._load_nodes(payload.get("nodes", []))
        center_latitude = (
            min(node.latitude for node in self.nodes.values())
            + max(node.latitude for node in self.nodes.values())
        ) / 2
        longitude_scale = 111_000.0 * cos(radians(center_latitude))
        self.projected_node_positions = {
            node_id: (
                node.longitude * longitude_scale,
                node.latitude * 110_900.0,
            )
            for node_id, node in self.nodes.items()
        }
        self.edges = self._load_edges(payload.get("edges", []))
        self.edges_by_id = {edge.id: edge for edge in self.edges}
        if len(self.edges_by_id) != len(self.edges):
            raise ValueError("Az úthálózatban ismétlődő élazonosító található.")

        self.turn_rules, self.sequence_turn_rules = self._load_restrictions(
            payload.get("restrictions", [])
        )
        self.maximum_way_history = max(
            (len(rule.path_way_ids) for rules in self.sequence_turn_rules.values() for rule in rules),
            default=2,
        )
        self.edges_by_mode = {
            mode: self._largest_weak_component_edges(
                tuple(
                    edge
                    for edge in self.edges
                    if _edge_usable_for_mode(edge, mode)
                )
            )
            for mode in VALID_MODES
        }
        for mode, edges in self.edges_by_mode.items():
            if not edges:
                raise ValueError(f"Nincs {mode} módban használható hálózati él.")
        self.outgoing: dict[tuple[int, str], list[NetworkEdge]] = {}
        for mode, edges in self.edges_by_mode.items():
            for edge in edges:
                self.outgoing.setdefault((edge.from_node, mode), []).append(edge)
        for outgoing_edges in self.outgoing.values():
            outgoing_edges.sort(key=lambda edge: edge.id)
        self.node_ids_by_mode = {
            mode: tuple(
                sorted(
                    {
                        edge.from_node
                        for edge in edges
                    }
                )
            )
            for mode, edges in self.edges_by_mode.items()
        }
        self._node_spatial_index = {
            mode: self._build_node_spatial_index(node_ids)
            for mode, node_ids in self.node_ids_by_mode.items()
        }
        self.routing_core_nodes = {
            mode: self._largest_strong_component(mode)
            for mode in sorted(VALID_MODES)
        }
        (
            self.routing_backbone_nodes,
            self.branch_depth_meters,
        ) = self._routing_backbones()
        self.pois = self._load_pois(payload.get("pois", []))

    @staticmethod
    def _largest_weak_component_edges(
        edges: tuple[NetworkEdge, ...],
    ) -> tuple[NetworkEdge, ...]:
        adjacency: dict[int, list[int]] = {}
        for edge in edges:
            adjacency.setdefault(edge.from_node, []).append(edge.to_node)
            adjacency.setdefault(edge.to_node, []).append(edge.from_node)
        unseen = set(adjacency)
        components: list[set[int]] = []
        while unseen:
            start = min(unseen)
            component: set[int] = set()
            stack = [start]
            while stack:
                node_id = stack.pop()
                if node_id in component:
                    continue
                component.add(node_id)
                unseen.discard(node_id)
                stack.extend(
                    neighbor
                    for neighbor in adjacency.get(node_id, ())
                    if neighbor not in component
                )
            components.append(component)
        if not components:
            return ()
        retained_nodes = min(
            components,
            key=lambda component: (-len(component), min(component)),
        )
        return tuple(
            edge
            for edge in edges
            if edge.from_node in retained_nodes and edge.to_node in retained_nodes
        )

    @staticmethod
    def _load_nodes(raw_nodes: Iterable[dict[str, Any]]) -> dict[int, NetworkNode]:
        nodes: dict[int, NetworkNode] = {}
        for raw in raw_nodes:
            node = NetworkNode(
                id=int(raw["id"]),
                latitude=float(raw["lat"]),
                longitude=float(raw["lng"]),
                traffic_signal=bool(raw.get("trafficSignal", False)),
                crossing=bool(raw.get("crossing", False)),
            )
            nodes[node.id] = node
        if not nodes:
            raise ValueError("Az úthálózat nem tartalmaz csomópontot.")
        return nodes

    def _load_edges(self, raw_edges: Iterable[dict[str, Any]]) -> tuple[NetworkEdge, ...]:
        edges: list[NetworkEdge] = []
        for raw in raw_edges:
            from_node = int(raw["from"])
            to_node = int(raw["to"])
            if from_node not in self.nodes or to_node not in self.nodes:
                continue
            start_node = self.nodes[from_node]
            end_node = self.nodes[to_node]
            start = (start_node.latitude, start_node.longitude)
            end = (end_node.latitude, end_node.longitude)
            length = float(raw.get("lengthMeters") or haversine_distance(start, end))
            if length <= 0:
                continue
            raw_turn_lanes = raw.get("turnLanes") or []
            turn_lanes = tuple(
                tuple(str(token).strip() for token in lane if str(token).strip())
                if isinstance(lane, list)
                else tuple(
                    token.strip() for token in str(lane).split(";") if token.strip()
                )
                for lane in raw_turn_lanes
            )
            modes = frozenset(str(mode) for mode in raw.get("modes", []) if mode in VALID_MODES)
            if not modes:
                continue
            lanes = max(1, int(raw.get("lanes") or 1))
            edges.append(
                NetworkEdge(
                    id=str(raw["id"]),
                    segment_id=str(raw.get("segmentId") or raw["id"]),
                    way_id=int(raw["wayId"]),
                    from_node=from_node,
                    to_node=to_node,
                    modes=modes,
                    lanes=lanes,
                    total_lanes=max(lanes, int(raw.get("totalLanes") or lanes)),
                    direction=str(raw.get("direction") or "forward"),
                    turn_lanes=turn_lanes,
                    max_speed_kph=max(3.0, float(raw.get("maxSpeedKph") or 30)),
                    length_meters=length,
                    bearing=_bearing(start, end),
                    start=start,
                    end=end,
                    highway=str(raw.get("highway") or "road"),
                )
            )
        if not edges:
            raise ValueError("Az úthálózat nem tartalmaz használható élt.")
        return tuple(edges)

    @staticmethod
    def _load_pois(raw_pois: Iterable[dict[str, Any]]) -> tuple[NetworkPOI, ...]:
        pois: list[NetworkPOI] = []
        seen_ids: set[str] = set()
        for raw in raw_pois:
            try:
                poi_id = str(raw["id"])
                latitude = float(raw["lat"])
                longitude = float(raw["lng"])
            except (KeyError, TypeError, ValueError):
                continue
            if not poi_id or poi_id in seen_ids:
                continue
            raw_modes = raw.get("tripModes") or VALID_MODES
            if isinstance(raw_modes, str):
                raw_modes = [raw_modes]
            trip_modes = frozenset(
                str(mode) for mode in raw_modes if str(mode) in VALID_MODES
            )
            if not trip_modes:
                continue
            raw_tags = raw.get("tags") or {}
            # A downloader már normalizált string-string tag-szótárat ír.
            # Ennek újramásolása 16 ezer POI-nál felesleges allokáció lenne
            # minden szerverindításkor.
            tags = raw_tags if isinstance(raw_tags, dict) else {}
            raw_osm_id = raw.get("osmId", poi_id)
            try:
                osm_id: int | str = int(raw_osm_id)
            except (TypeError, ValueError):
                osm_id = str(raw_osm_id)
            try:
                weight = max(0.01, float(raw.get("weight") or 1.0))
            except (TypeError, ValueError):
                weight = 1.0
            seen_ids.add(poi_id)
            pois.append(
                NetworkPOI(
                    id=poi_id,
                    osm_type=str(raw.get("osmType") or "node"),
                    osm_id=osm_id,
                    latitude=latitude,
                    longitude=longitude,
                    name=str(raw.get("name") or raw.get("subtype") or "Névtelen hely"),
                    category=str(raw.get("category") or "other"),
                    subtype=str(raw.get("subtype") or ""),
                    tags=tags,
                    trip_modes=trip_modes,
                    weight=weight,
                    has_name=bool(str(raw.get("name") or "").strip()),
                )
            )
        return tuple(pois)

    def _build_node_spatial_index(
        self, node_ids: Iterable[int]
    ) -> dict[tuple[int, int], tuple[int, ...]]:
        buckets: dict[tuple[int, int], list[int]] = {}
        for node_id in node_ids:
            node = self.nodes[node_id]
            key = (
                floor(node.latitude / SPATIAL_CELL_DEGREES),
                floor(node.longitude / SPATIAL_CELL_DEGREES),
            )
            buckets.setdefault(key, []).append(node_id)
        return {key: tuple(sorted(values)) for key, values in buckets.items()}

    def _largest_strong_component(self, mode: str) -> frozenset[int]:
        """Largest directed routing core, ignoring only turn restrictions."""

        node_ids = set(self.node_ids_by_mode[mode])
        adjacency: dict[int, tuple[int, ...]] = {}
        reverse: dict[int, list[int]] = {node_id: [] for node_id in node_ids}
        for node_id in node_ids:
            neighbors = tuple(
                edge.to_node
                for edge in self.outgoing.get((node_id, mode), ())
                if edge.to_node in node_ids
            )
            adjacency[node_id] = neighbors
            for neighbor in neighbors:
                reverse[neighbor].append(node_id)

        visited: set[int] = set()
        finish_order: list[int] = []
        for start in sorted(node_ids):
            if start in visited:
                continue
            visited.add(start)
            stack: list[tuple[int, int]] = [(start, 0)]
            while stack:
                node_id, next_index = stack[-1]
                neighbors = adjacency[node_id]
                if next_index < len(neighbors):
                    neighbor = neighbors[next_index]
                    stack[-1] = (node_id, next_index + 1)
                    if neighbor not in visited:
                        visited.add(neighbor)
                        stack.append((neighbor, 0))
                    continue
                stack.pop()
                finish_order.append(node_id)

        assigned: set[int] = set()
        largest: set[int] = set()
        for start in reversed(finish_order):
            if start in assigned:
                continue
            component: set[int] = set()
            stack = [start]
            assigned.add(start)
            while stack:
                node_id = stack.pop()
                component.add(node_id)
                for neighbor in reverse[node_id]:
                    if neighbor not in assigned:
                        assigned.add(neighbor)
                        stack.append(neighbor)
            if (
                len(component) > len(largest)
                or (
                    len(component) == len(largest)
                    and component
                    and (not largest or min(component) < min(largest))
                )
            ):
                largest = component
        return frozenset(largest)

    def _routing_backbones(
        self,
    ) -> tuple[dict[str, frozenset[int]], dict[str, dict[int, float]]]:
        """Return the undirected 2-core and distance of each attached branch.

        A bidirectional cul-de-sac belongs to the directed SCC, therefore SCC
        membership alone cannot distinguish a through road from a dead branch.
        The undirected 2-core is the stable through-network used for anchor
        ranking; destinations on branches remain routable.
        """

        backbones: dict[str, frozenset[int]] = {}
        branch_depths: dict[str, dict[int, float]] = {}
        for mode in sorted(VALID_MODES):
            adjacency: dict[int, set[int]] = {}
            lengths: dict[tuple[int, int], float] = {}
            for edge in self.edges_by_mode[mode]:
                adjacency.setdefault(edge.from_node, set()).add(edge.to_node)
                adjacency.setdefault(edge.to_node, set()).add(edge.from_node)
                key = tuple(sorted((edge.from_node, edge.to_node)))
                lengths[key] = min(lengths.get(key, float("inf")), edge.length_meters)

            degree = {node_id: len(neighbors) for node_id, neighbors in adjacency.items()}
            removed: set[int] = set()
            queue = deque(sorted(node_id for node_id, value in degree.items() if value < 2))
            while queue:
                node_id = queue.popleft()
                if node_id in removed:
                    continue
                removed.add(node_id)
                for neighbor in adjacency.get(node_id, ()):
                    if neighbor in removed:
                        continue
                    degree[neighbor] -= 1
                    if degree[neighbor] == 1:
                        queue.append(neighbor)

            backbone = frozenset(set(adjacency) - removed)
            backbones[mode] = backbone
            if not backbone:
                branch_depths[mode] = {
                    node_id: 0.0 for node_id in adjacency
                }
                continue
            depths = {node_id: 0.0 for node_id in backbone}
            heap: list[tuple[float, int]] = []
            for node_id in sorted(backbone):
                heappush(heap, (0.0, node_id))
            while heap:
                distance, node_id = heappop(heap)
                if distance > depths.get(node_id, float("inf")) + 1e-9:
                    continue
                for neighbor in adjacency.get(node_id, ()):
                    next_distance = distance + lengths[
                        tuple(sorted((node_id, neighbor)))
                    ]
                    if next_distance >= depths.get(neighbor, float("inf")) - 1e-9:
                        continue
                    depths[neighbor] = next_distance
                    heappush(heap, (next_distance, neighbor))
            branch_depths[mode] = depths
        return backbones, branch_depths

    def nearest_node(
        self,
        latitude: float,
        longitude: float,
        mode: str,
        *,
        max_distance_meters: float | None = None,
        prefer_suitable_highway: bool = False,
        allowed_node_ids: frozenset[int] | None = None,
    ) -> int | None:
        """A POI-hoz közeli, az adott módban használható csomópont."""

        if mode not in VALID_MODES:
            raise ValueError(f"Ismeretlen közlekedési mód: {mode}")
        node_ids = self.node_ids_by_mode[mode]
        if not node_ids:
            return None
        base = (
            floor(float(latitude) / SPATIAL_CELL_DEGREES),
            floor(float(longitude) / SPATIAL_CELL_DEGREES),
        )
        index = self._node_spatial_index[mode]
        candidates: list[int] = []
        first_match_radius: int | None = None
        for radius in range(13):
            for latitude_offset in range(-radius, radius + 1):
                for longitude_offset in range(-radius, radius + 1):
                    if radius and max(abs(latitude_offset), abs(longitude_offset)) != radius:
                        continue
                    bucket_nodes = index.get(
                        (base[0] + latitude_offset, base[1] + longitude_offset),
                        (),
                    )
                    candidates.extend(
                        node_id
                        for node_id in bucket_nodes
                        if allowed_node_ids is None or node_id in allowed_node_ids
                    )
            if candidates and first_match_radius is None:
                first_match_radius = radius
            # Az első találat köré még egy cellagyűrűt vizsgálunk, hogy egy
            # cellahatár ne válasszon távolabbi csomópontot.
            if first_match_radius is not None and radius >= first_match_radius + 1:
                break
        if not candidates and max_distance_meters is None:
            candidates = [
                node_id
                for node_id in node_ids
                if allowed_node_ids is None or node_id in allowed_node_ids
            ]
        target = (float(latitude), float(longitude))
        candidates_with_distance = [
            (
                node_id,
                haversine_distance(
                    target,
                    (self.nodes[node_id].latitude, self.nodes[node_id].longitude),
                ),
            )
            for node_id in candidates
        ]
        if max_distance_meters is not None:
            candidates_with_distance = [
                item
                for item in candidates_with_distance
                if item[1] <= max(0.0, float(max_distance_meters))
            ]
        if not candidates_with_distance:
            return None

        priorities = SNAP_HIGHWAY_PRIORITY[mode]

        def node_priority(node_id: int) -> int:
            if not prefer_suitable_highway:
                return 0
            return min(
                (
                    priorities.get(edge.highway, 20)
                    for edge in self.outgoing.get((node_id, mode), ())
                ),
                default=20,
            )

        return min(
            candidates_with_distance,
            key=lambda item: (
                item[1] + node_priority(item[0]) * 15.0,
                item[1],
                item[0],
            ),
        )[0]

    @staticmethod
    def _load_restrictions(
        raw_restrictions: Iterable[dict[str, Any]],
    ) -> tuple[
        dict[tuple[int, int], tuple[TurnRule, ...]],
        dict[int, tuple[SequenceTurnRule, ...]],
    ]:
        rules: dict[tuple[int, int], list[TurnRule]] = {}
        sequence_rules: dict[int, list[SequenceTurnRule]] = {}
        for raw in raw_restrictions:
            raw_exceptions = raw.get("except") or []
            if isinstance(raw_exceptions, list):
                exceptions = {str(item).strip() for item in raw_exceptions if str(item).strip()}
            else:
                exceptions = {
                    item.strip()
                    for item in str(raw_exceptions).replace(",", ";").split(";")
                    if item.strip()
                }
            if "motorcar" in exceptions or "vehicle" in exceptions:
                continue
            via_nodes = tuple(int(value) for value in raw.get("viaNodes", []))
            via_ways = tuple(int(value) for value in raw.get("viaWays", []))
            from_ways = tuple(int(value) for value in raw.get("fromWays", []))
            to_ways = frozenset(int(value) for value in raw.get("toWays", []))
            if not from_ways or not to_ways:
                continue
            restriction = str(raw.get("restriction") or "")
            if via_ways:
                for from_way in from_ways:
                    sequence_rule = SequenceTurnRule(
                        restriction=restriction,
                        path_way_ids=(from_way, *via_ways),
                        to_way_ids=to_ways,
                    )
                    sequence_rules.setdefault(via_ways[-1], []).append(sequence_rule)
                continue
            if len(via_nodes) != 1:
                continue
            rule = TurnRule(
                restriction=restriction,
                to_way_ids=to_ways,
            )
            for from_way in from_ways:
                rules.setdefault((via_nodes[0], from_way), []).append(rule)
        return (
            {key: tuple(value) for key, value in rules.items()},
            {key: tuple(value) for key, value in sequence_rules.items()},
        )

    def allowed_outgoing(
        self,
        edge: NetworkEdge,
        mode: str,
        way_history: tuple[int, ...] = (),
        allow_forced_u_turn: bool = True,
    ) -> tuple[NetworkEdge, ...]:
        candidates = list(self.outgoing.get((edge.to_node, mode), ()))
        if not candidates:
            return ()
        if mode == "car":
            rules = self.turn_rules.get((edge.to_node, edge.way_id), ())
            historical_rules = tuple(
                rule
                for rule in self.sequence_turn_rules.get(edge.way_id, ())
                if len(way_history) >= len(rule.path_way_ids)
                and tuple(way_history[-len(rule.path_way_ids) :]) == rule.path_way_ids
            )
            only_targets: set[int] = set()
            forbidden_targets: set[int] = set()
            for rule in (*rules, *historical_rules):
                if rule.restriction.startswith("only_"):
                    only_targets.update(rule.to_way_ids)
                elif rule.restriction.startswith("no_"):
                    forbidden_targets.update(rule.to_way_ids)
            if only_targets:
                candidates = [candidate for candidate in candidates if candidate.way_id in only_targets]
            if forbidden_targets:
                candidates = [candidate for candidate in candidates if candidate.way_id not in forbidden_targets]

        without_u_turn = [
            candidate
            for candidate in candidates
            if not (
                candidate.to_node == edge.from_node
                and candidate.segment_id == edge.segment_id
            )
        ]
        if without_u_turn or not allow_forced_u_turn:
            return tuple(without_u_turn)
        return tuple(candidates)

    def lane_options_for_turn(
        self, edge: NetworkEdge, outgoing: NetworkEdge
    ) -> tuple[int, ...]:
        if not edge.turn_lanes:
            return tuple(range(edge.lanes))
        turn_kind = _turn_kind(edge.bearing, outgoing.bearing)
        matching = tuple(
            lane_index
            for lane_index, tokens in enumerate(edge.turn_lanes[: edge.lanes])
            if _turn_token_matches(tokens, turn_kind)
        )
        return matching or tuple(range(edge.lanes))

    def extend_way_history(
        self, way_history: tuple[int, ...], next_way_id: int
    ) -> tuple[int, ...]:
        if way_history and way_history[-1] == next_way_id:
            return way_history
        return (*way_history, next_way_id)[-self.maximum_way_history :]

    def shortest_route(
        self,
        origin_node: int,
        destination_node: int,
        mode: str,
        *,
        max_expansions: int = MAX_ROUTE_EXPANSIONS,
        segment_usage: dict[str, int] | None = None,
        reuse_penalty: float = 0.0,
    ) -> tuple[NetworkEdge, ...] | None:
        """Restriction-aware A* route represented as a directed edge sequence."""

        if mode not in VALID_MODES:
            raise ValueError(f"Ismeretlen közlekedési mód: {mode}")
        if origin_node == destination_node:
            return ()
        if origin_node not in self.nodes or destination_node not in self.nodes:
            return None
        if mode == "pedestrian":
            return self._shortest_node_route(
                origin_node,
                destination_node,
                mode,
                max_expansions=max_expansions,
                segment_usage=segment_usage,
                reuse_penalty=reuse_penalty,
            )

        heuristic_cache: dict[int, float] = {}

        def heuristic(node_id: int) -> float:
            cached = heuristic_cache.get(node_id)
            if cached is not None:
                return cached
            first_x, first_y = self.projected_node_positions[node_id]
            second_x, second_y = self.projected_node_positions[destination_node]
            distance = hypot(first_x - second_x, first_y - second_y)
            # Car costs are seconds; 130 km/h is an admissible upper speed.
            estimate = distance / (160.0 / 3.6)
            heuristic_cache[node_id] = estimate
            return estimate

        def edge_cost(edge: NetworkEdge) -> float:
            base_seconds = edge.length_meters / (edge.max_speed_kph / 3.6)
            usage = (segment_usage or {}).get(edge.segment_id, 0)
            reuse_factor = 1.0 + max(0.0, reuse_penalty) * usage / (usage + 4.0)
            return base_seconds * reuse_factor

        State = tuple[str, tuple[int, ...]]
        frontier: list[tuple[float, float, str, tuple[int, ...]]] = []
        best_cost: dict[State, float] = {}
        previous: dict[State, State | None] = {}

        for edge in self.outgoing.get((origin_node, mode), ()):
            history = (edge.way_id,)
            state = (edge.id, history)
            cost = edge_cost(edge)
            if cost >= best_cost.get(state, float("inf")):
                continue
            best_cost[state] = cost
            previous[state] = None
            heappush(
                frontier,
                (cost + heuristic(edge.to_node), cost, edge.id, history),
            )

        expansions = 0
        while frontier and expansions < max(1, int(max_expansions)):
            _, cost, edge_id, history = heappop(frontier)
            state = (edge_id, history)
            if cost > best_cost.get(state, float("inf")) + 1e-9:
                continue
            edge = self.edges_by_id[edge_id]
            if edge.to_node == destination_node:
                path_ids: list[str] = []
                cursor: State | None = state
                while cursor is not None:
                    path_ids.append(cursor[0])
                    cursor = previous[cursor]
                path_ids.reverse()
                return tuple(self.edges_by_id[path_id] for path_id in path_ids)

            expansions += 1
            for outgoing in self.allowed_outgoing(
                edge,
                mode,
                history,
                allow_forced_u_turn=False,
            ):
                next_history = self.extend_way_history(history, outgoing.way_id)
                next_state = (outgoing.id, next_history)
                turn_kind = _turn_kind(edge.bearing, outgoing.bearing)
                turn_seconds = {
                    "through": 0.0,
                    "right": 0.8,
                    "left": 2.5,
                    "reverse": 12.0,
                }[turn_kind]
                next_cost = cost + edge_cost(outgoing) + turn_seconds
                if next_cost >= best_cost.get(next_state, float("inf")) - 1e-9:
                    continue
                best_cost[next_state] = next_cost
                previous[next_state] = state
                heappush(
                    frontier,
                    (
                        next_cost + heuristic(outgoing.to_node),
                        next_cost,
                        outgoing.id,
                        next_history,
                    ),
                )
        return None

    def _shortest_node_route(
        self,
        origin_node: int,
        destination_node: int,
        mode: str,
        *,
        max_expansions: int,
        segment_usage: dict[str, int] | None = None,
        reuse_penalty: float = 0.0,
    ) -> tuple[NetworkEdge, ...] | None:
        """Fast node-state A* for modes without vehicle turn restrictions."""

        destination_x, destination_y = self.projected_node_positions[
            destination_node
        ]

        def heuristic(node_id: int) -> float:
            node_x, node_y = self.projected_node_positions[node_id]
            return hypot(node_x - destination_x, node_y - destination_y)

        frontier: list[tuple[float, float, int]] = [
            (heuristic(origin_node), 0.0, origin_node)
        ]
        best_cost = {origin_node: 0.0}
        previous: dict[int, tuple[int, str]] = {}
        expansions = 0
        while frontier and expansions < max(1, int(max_expansions)):
            _, cost, node_id = heappop(frontier)
            if cost > best_cost.get(node_id, float("inf")) + 1e-9:
                continue
            if node_id == destination_node:
                path_ids: list[str] = []
                cursor = destination_node
                while cursor != origin_node:
                    cursor, edge_id = previous[cursor]
                    path_ids.append(edge_id)
                path_ids.reverse()
                return tuple(self.edges_by_id[edge_id] for edge_id in path_ids)
            expansions += 1
            for edge in self.outgoing.get((node_id, mode), ()):
                route_multiplier = PEDESTRIAN_ROUTE_COST_MULTIPLIER.get(
                    edge.highway, 1.25
                )
                usage = (segment_usage or {}).get(edge.segment_id, 0)
                reuse_factor = (
                    1.0
                    + max(0.0, reuse_penalty) * usage / (usage + 4.0)
                )
                next_cost = (
                    cost
                    + edge.length_meters * route_multiplier * reuse_factor
                )
                if next_cost >= best_cost.get(edge.to_node, float("inf")) - 1e-9:
                    continue
                best_cost[edge.to_node] = next_cost
                previous[edge.to_node] = (node_id, edge.id)
                heappush(
                    frontier,
                    (
                        next_cost + heuristic(edge.to_node),
                        next_cost,
                        edge.to_node,
                    ),
                )
        return None


@dataclass(slots=True)
class NetworkAgent:
    id: int
    mode: str
    edge: NetworkEdge
    distance_meters: float
    desired_speed_mps: float
    current_speed_mps: float
    lane_index: int
    planned_edge_id: str | None
    wait_seconds: float = 0.0
    signal_checked: bool = False
    trip_distance_meters: float = 0.0
    trip_target_meters: float = 1_000.0
    way_history: tuple[int, ...] = ()
    route_edge_ids: tuple[str, ...] = ()
    route_index: int = 0
    origin_poi: NetworkPOI | None = None
    destination_poi: NetworkPOI | None = None
    origin_snap_distance_meters: float = 0.0
    destination_snap_distance_meters: float = 0.0
    origin_poi_kind: str = "poi"
    destination_poi_kind: str = "poi"
    relocation_generation: int = 0
    free_flow_speed_ratio: float | None = None
    car_headway_path_cache: tuple[Any, ...] | None = None
    car_merge_path_cache: tuple[Any, ...] | None = None
    car_density_window_cache: tuple[Any, ...] | None = None


class NetworkTrafficSimulation:
    """A hálózaton folytonosan továbbhaladó autók és gyalogosok modellje."""

    def __init__(
        self,
        network: RoadNetwork | dict[str, Any],
        *,
        cars: int = 400,
        pedestrians: int = 600,
        seed: int = 11_2026,
        route_catalog: dict[str, Any] | None = None,
    ) -> None:
        self.network = network if isinstance(network, RoadNetwork) else RoadNetwork(network)
        self.seed = seed
        self.random = Random(seed)
        self.agents: list[NetworkAgent] = []
        self.elapsed_seconds = 0.0
        self.completed_trips = 0
        self.segment_passed_cars: Counter[str] = Counter()
        self._segment_metric_buckets: deque[
            tuple[float, dict[str, tuple[float, float, float]]]
        ] = deque()
        self._segment_metric_totals: dict[str, list[float]] = {}
        self.next_agent_id = 1
        self.route_cache: dict[
            tuple[str, str, str], tuple[str, ...] | None
        ] = {}
        self.route_segment_usage: dict[str, Counter[str]] = {
            mode: Counter() for mode in VALID_MODES
        }
        self.route_choice_counts: Counter[tuple[str, str, str]] = Counter()
        self.gateway_exits = 0
        self.gateway_entries = 0
        self.route_reseeds = 0
        self.route_cache_ready = False
        self.route_pois_by_mode: dict[str, tuple[SnappedPOI, ...]] = {}
        self.route_pois_by_id: dict[str, dict[str, SnappedPOI]] = {}
        self.route_successors: dict[str, dict[str, tuple[SnappedPOI, ...]]] = {}
        self.route_selection_stats: dict[str, dict[str, Any]] = {}
        self.route_catalog_loaded = False
        self._network_bounds_cache: tuple[float, float, float, float] | None = None
        self._lane_transition_cache: dict[
            tuple[str, int, str, tuple[int, ...]], int
        ] = {}
        self._turn_lane_options_cache: dict[
            tuple[str, str], tuple[int, ...]
        ] = {}
        self._merge_candidate_edge_ids = (
            self._build_merge_candidate_edge_ids()
        )
        self._active_merge_approaches: dict[
            tuple[str, int], int
        ] | None = None
        if route_catalog is not None:
            self.route_catalog_loaded = self._load_route_catalog(route_catalog)
        if not self.route_catalog_loaded:
            self._prepare_route_pois()
            self._warm_route_cache()
        self.set_agent_targets(cars=cars, pedestrians=pedestrians)

    def reset(self) -> None:
        stats = self.stats()
        self.random.seed(self.seed)
        self.agents.clear()
        self.elapsed_seconds = 0.0
        self.completed_trips = 0
        self.segment_passed_cars.clear()
        self._segment_metric_buckets.clear()
        self._segment_metric_totals.clear()
        self.gateway_exits = 0
        self.gateway_entries = 0
        self.route_reseeds = 0
        self.route_choice_counts.clear()
        self.next_agent_id = 1
        self.set_agent_targets(cars=int(stats["cars"]), pedestrians=int(stats["pedestrians"]))

    @staticmethod
    def _catalog_poi_record(poi: NetworkPOI) -> dict[str, Any]:
        return {
            "id": poi.id,
            "osmType": poi.osm_type,
            "osmId": poi.osm_id,
            "lat": poi.latitude,
            "lng": poi.longitude,
            "name": poi.name,
            "category": poi.category,
            "subtype": poi.subtype,
            "tags": poi.tags,
            "tripModes": sorted(poi.trip_modes),
            "weight": poi.weight,
            "hasName": poi.has_name,
        }

    @staticmethod
    def _catalog_poi_from_record(raw: dict[str, Any]) -> NetworkPOI:
        return NetworkPOI(
            id=str(raw["id"]),
            osm_type=str(raw.get("osmType") or "synthetic"),
            osm_id=raw.get("osmId", raw["id"]),
            latitude=float(raw["lat"]),
            longitude=float(raw["lng"]),
            name=str(raw.get("name") or "Forgalmi kapu"),
            category=str(raw.get("category") or "gateway"),
            subtype=str(raw.get("subtype") or "road"),
            tags={
                str(key): str(value)
                for key, value in (raw.get("tags") or {}).items()
            },
            trip_modes=frozenset(
                str(mode)
                for mode in raw.get("tripModes", ())
                if str(mode) in VALID_MODES
            ),
            weight=max(0.01, float(raw.get("weight") or 1.0)),
            has_name=bool(raw.get("hasName", True)),
        )

    def export_route_catalog(self) -> dict[str, Any]:
        modes: dict[str, Any] = {}
        for mode in sorted(VALID_MODES):
            anchors = self.route_pois_by_mode[mode]
            modes[mode] = {
                "anchors": [
                    {
                        "poiId": anchor.poi.id,
                        "nodeId": anchor.node_id,
                        "snapDistanceMeters": anchor.snap_distance_meters,
                        "gateway": anchor.gateway,
                        "portalRole": anchor.portal_role,
                        "corridorId": anchor.corridor_id,
                        "branchDepthMeters": anchor.branch_depth_meters,
                        **(
                            {"poi": self._catalog_poi_record(anchor.poi)}
                            if anchor.gateway
                            else {}
                        ),
                    }
                    for anchor in anchors
                ],
                "successors": [
                    [
                        origin_id,
                        [destination.poi.id for destination in destinations],
                    ]
                    for origin_id, destinations in sorted(
                        self.route_successors[mode].items()
                    )
                ],
                "routes": [
                    [origin_id, destination_id, list(route_edge_ids)]
                    for (route_mode, origin_id, destination_id), route_edge_ids
                    in sorted(self.route_cache.items())
                    if route_mode == mode and route_edge_ids
                ],
                "stats": dict(self.route_selection_stats[mode]),
            }
        return {
            "meta": {
                "catalogVersion": ROUTE_CATALOG_VERSION,
                "networkId": self.network.meta.get("networkId"),
                "routeGridSize": ROUTE_GRID_SIZE,
                "destinationCandidates": MAX_ROUTE_DESTINATION_CANDIDATES,
            },
            "modes": modes,
        }

    def _load_route_catalog(self, catalog: dict[str, Any]) -> bool:
        try:
            metadata = catalog["meta"]
            if int(metadata["catalogVersion"]) != ROUTE_CATALOG_VERSION:
                return False
            if metadata.get("networkId") != self.network.meta.get("networkId"):
                return False
            raw_modes = catalog["modes"]
            poi_by_id = {poi.id: poi for poi in self.network.pois}
            loaded_anchors: dict[str, tuple[SnappedPOI, ...]] = {}
            loaded_by_id: dict[str, dict[str, SnappedPOI]] = {}
            for mode in sorted(VALID_MODES):
                mode_payload = raw_modes[mode]
                anchors: list[SnappedPOI] = []
                for raw_anchor in mode_payload["anchors"]:
                    poi_id = str(raw_anchor["poiId"])
                    raw_poi = raw_anchor.get("poi")
                    poi = (
                        self._catalog_poi_from_record(raw_poi)
                        if isinstance(raw_poi, dict)
                        else poi_by_id[poi_id]
                    )
                    node_id = int(raw_anchor["nodeId"])
                    if node_id not in self.network.nodes:
                        return False
                    anchors.append(
                        SnappedPOI(
                            poi=poi,
                            node_id=node_id,
                            snap_distance_meters=float(
                                raw_anchor.get("snapDistanceMeters") or 0.0
                            ),
                            gateway=bool(raw_anchor.get("gateway", False)),
                            portal_role=str(
                                raw_anchor.get("portalRole") or "both"
                            ),
                            corridor_id=str(
                                raw_anchor.get("corridorId") or ""
                            ),
                            branch_depth_meters=float(
                                raw_anchor.get("branchDepthMeters") or 0.0
                            ),
                        )
                    )
                loaded_anchors[mode] = tuple(anchors)
                loaded_by_id[mode] = {
                    anchor.poi.id: anchor for anchor in anchors
                }

            loaded_successors: dict[
                str, dict[str, tuple[SnappedPOI, ...]]
            ] = {}
            loaded_cache: dict[
                tuple[str, str, str], tuple[str, ...] | None
            ] = {}
            for mode in sorted(VALID_MODES):
                mode_payload = raw_modes[mode]
                mode_by_id = loaded_by_id[mode]
                successors: dict[str, tuple[SnappedPOI, ...]] = {}
                for origin_id, destination_ids in mode_payload["successors"]:
                    origin_id = str(origin_id)
                    if origin_id not in mode_by_id:
                        return False
                    successors[origin_id] = tuple(
                        mode_by_id[str(destination_id)]
                        for destination_id in destination_ids
                    )
                loaded_successors[mode] = successors
                for origin_id, destination_id, edge_ids in mode_payload["routes"]:
                    route_ids = tuple(str(edge_id) for edge_id in edge_ids)
                    if not route_ids or any(
                        edge_id not in self.network.edges_by_id
                        for edge_id in route_ids
                    ):
                        return False
                    loaded_cache[
                        (mode, str(origin_id), str(destination_id))
                    ] = route_ids

            self.route_pois_by_mode = loaded_anchors
            self.route_pois_by_id = loaded_by_id
            self.route_successors = loaded_successors
            self.route_cache = loaded_cache
            self.route_selection_stats = {
                mode: dict(raw_modes[mode].get("stats") or {})
                for mode in sorted(VALID_MODES)
            }
            for (mode, _, _), edge_ids in self.route_cache.items():
                if edge_ids:
                    self.route_segment_usage[mode].update(
                        self.network.edges_by_id[edge_id].segment_id
                        for edge_id in edge_ids
                    )
            self.route_cache_ready = True
            return True
        except (KeyError, TypeError, ValueError):
            return False

    def _prepare_route_pois(self) -> None:
        for mode_index, mode in enumerate(sorted(VALID_MODES)):
            poi_anchors, catalog_stats = self._select_diverse_poi_anchors(mode)
            used_nodes = {anchor.node_id for anchor in poi_anchors}
            gateway_anchors = self._gateway_anchors(mode, used_nodes)
            snapped = [*poi_anchors, *gateway_anchors]

            # Az útvonalkatalógus legyen minden ágens-seednél ugyanaz: így egy
            # másik reprodukciós seed nem teheti többszörösen drágábbá az A*
            # előkészítést, miközben az ágensek választása továbbra is seedelt.
            route_random = Random(
                ROUTE_CATALOG_SEED + 10_007 * (mode_index + 1)
            )
            route_random.shuffle(snapped)
            anchors = tuple(snapped)
            self.route_pois_by_mode[mode] = anchors
            self.route_pois_by_id[mode] = {
                anchor.poi.id: anchor for anchor in anchors
            }

            self.route_successors[mode] = self._candidate_route_successors(
                mode, anchors
            )
            self.route_selection_stats[mode] = {
                **catalog_stats,
                "poiAnchors": len(poi_anchors),
                "gatewayAnchors": len(gateway_anchors),
                "anchors": len(anchors),
                "namedPoiAnchors": sum(
                    anchor.poi.has_name for anchor in poi_anchors
                ),
                "gridCells": len(
                    {
                        self._route_grid_cell(
                            anchor.poi.latitude, anchor.poi.longitude
                        )
                        for anchor in poi_anchors
                    }
                ),
                "maxSnapDistanceMeters": max(
                    (anchor.snap_distance_meters for anchor in poi_anchors),
                    default=0.0,
                ),
                "routingCoreNodes": len(
                    self.network.routing_core_nodes[mode]
                ),
                "gatewayHighways": {
                    highway: sum(
                        anchor.poi.subtype == highway
                        for anchor in gateway_anchors
                    )
                    for highway in sorted(
                        {anchor.poi.subtype for anchor in gateway_anchors}
                    )
                },
            }

    def _network_bounds(self) -> tuple[float, float, float, float]:
        if self._network_bounds_cache is not None:
            return self._network_bounds_cache
        raw_bounds = self.network.meta.get("bounds") or {}
        try:
            bounds = (
                float(raw_bounds["south"]),
                float(raw_bounds["west"]),
                float(raw_bounds["north"]),
                float(raw_bounds["east"]),
            )
        except (KeyError, TypeError, ValueError):
            latitudes = [node.latitude for node in self.network.nodes.values()]
            longitudes = [node.longitude for node in self.network.nodes.values()]
            bounds = (
                min(latitudes),
                min(longitudes),
                max(latitudes),
                max(longitudes),
            )
        self._network_bounds_cache = bounds
        return bounds

    def _route_grid_cell(self, latitude: float, longitude: float) -> tuple[int, int]:
        south, west, north, east = self._network_bounds()
        latitude_span = max(1e-9, north - south)
        longitude_span = max(1e-9, east - west)
        row = int((float(latitude) - south) / latitude_span * ROUTE_GRID_SIZE)
        column = int((float(longitude) - west) / longitude_span * ROUTE_GRID_SIZE)
        return (
            int(_clamp(row, 0, ROUTE_GRID_SIZE - 1)),
            int(_clamp(column, 0, ROUTE_GRID_SIZE - 1)),
        )

    def _fine_grid_cell(self, latitude: float, longitude: float) -> tuple[int, int]:
        south, west, north, east = self._network_bounds()
        latitude_span = max(1e-9, north - south)
        longitude_span = max(1e-9, east - west)
        row = int((float(latitude) - south) / latitude_span * ROUTE_FINE_GRID_SIZE)
        column = int(
            (float(longitude) - west) / longitude_span * ROUTE_FINE_GRID_SIZE
        )
        return (
            int(_clamp(row, 0, ROUTE_FINE_GRID_SIZE - 1)),
            int(_clamp(column, 0, ROUTE_FINE_GRID_SIZE - 1)),
        )

    @staticmethod
    def _destination_band_parameters(
        mode: str, band: str
    ) -> tuple[float, float, float]:
        bands = {
            "car": {
                "local": (300.0, 2_800.0, 1_400.0),
                "medium": (1_800.0, 5_500.0, 3_500.0),
                "far": (4_500.0, float("inf"), 6_500.0),
            },
            "pedestrian": {
                "local": (120.0, 1_350.0, 650.0),
                "medium": (1_100.0, 3_200.0, 2_100.0),
                "far": (2_800.0, float("inf"), 5_000.0),
            },
        }
        return bands[mode][band]

    @staticmethod
    def _destination_band_order(
        mode: str, origin: SnappedPOI, origin_index: int
    ) -> tuple[str, ...]:
        if origin.gateway:
            return ("far", "medium", "local")
        if mode == "pedestrian":
            selector = origin_index % 8
            second = (
                "local"
                if selector % 2 == 0
                else "far"
                if selector == 7
                else "medium"
            )
            fallback = "medium" if second == "local" else "local"
            return ("local", second, fallback)
        second = "far" if origin_index % 4 == 3 else "medium"
        fallback = "medium" if second == "far" else "far"
        return ("local", second, fallback)

    def _candidate_route_successors(
        self, mode: str, anchors: tuple[SnappedPOI, ...]
    ) -> dict[str, tuple[SnappedPOI, ...]]:
        successors: dict[str, tuple[SnappedPOI, ...]] = {}
        if len(anchors) < 2:
            return successors

        south, _, north, _ = self._network_bounds()
        longitude_scale = 111_000.0 * cos(radians((south + north) / 2))
        projected_positions = {
            anchor.poi.id: (
                anchor.poi.longitude * longitude_scale,
                anchor.poi.latitude * 110_900.0,
            )
            for anchor in anchors
        }

        destination_anchors = tuple(
            anchor for anchor in anchors if anchor.can_end_trip
        )
        hotspot_anchors = tuple(
            anchor
            for anchor in destination_anchors
            if not anchor.gateway
            and self._poi_attraction_score(anchor.poi)
            >= IMPORTANT_HOTSPOT_MIN_SCORE
        )

        for origin_index, origin in enumerate(anchors):
            if not origin.can_start_trip:
                continue
            choices: list[SnappedPOI] = []
            origin_x, origin_y = projected_positions[origin.poi.id]
            candidates: list[tuple[SnappedPOI, float, int]] = []
            for candidate in destination_anchors:
                if (
                    candidate.poi.id == origin.poi.id
                    or candidate.node_id == origin.node_id
                ):
                    continue
                candidate_x, candidate_y = projected_positions[candidate.poi.id]
                delta_x = origin_x - candidate_x
                delta_y = origin_y - candidate_y
                distance_squared = delta_x * delta_x + delta_y * delta_y
                sector = int(
                    ((degrees(atan2(-delta_y, -delta_x)) + 360.0) % 360.0)
                    // 45.0
                )
                candidates.append((candidate, distance_squared, sector))

            for band in self._destination_band_order(mode, origin, origin_index):
                minimum, maximum, target = self._destination_band_parameters(
                    mode, band
                )
                available = [
                    item for item in candidates if item[0] not in choices
                ]
                if not available:
                    continue

                in_band = [
                    item
                    for item in available
                    if minimum * minimum
                    <= item[1]
                    <= maximum * maximum
                ]
                pool = in_band or available

                def gateway_rank(candidate: SnappedPOI) -> int:
                    if band != "far":
                        return int(candidate.gateway)
                    if origin.gateway:
                        return int(candidate.gateway)
                    return int(not candidate.gateway)

                chosen, _ = min(
                    pool,
                    key=lambda item: (
                        gateway_rank(item[0]),
                        abs(item[1] - target * target),
                        item[0].branch_depth_meters > 500.0
                        and self._poi_attraction_score(item[0].poi)
                        < IMPORTANT_HOTSPOT_MIN_SCORE,
                        item[0].poi.category == origin.poi.category,
                        -self._poi_attraction_score(item[0].poi),
                        item[0].poi.id,
                    ),
                )[:2]
                choices.append(chosen)
                if len(choices) >= MAX_ROUTE_DESTINATION_CANDIDATES:
                    break

            if hotspot_anchors and len(choices) < MAX_ROUTE_DESTINATION_CANDIDATES:
                hotspot_pool = [
                    item
                    for item in candidates
                    if item[0] in hotspot_anchors and item[0] not in choices
                ]
                if mode == "pedestrian":
                    local_hotspots = [
                        item for item in hotspot_pool if item[1] <= 3_200.0**2
                    ]
                    hotspot_pool = local_hotspots or hotspot_pool
                if hotspot_pool:
                    target = 1_400.0 if mode == "pedestrian" else 4_500.0
                    chosen = min(
                        hotspot_pool,
                        key=lambda item: (
                            abs(item[1] - target * target),
                            -self._poi_attraction_score(item[0].poi),
                            item[0].poi.id,
                        ),
                    )[0]
                    choices.append(chosen)

            if mode == "car" and len(choices) < MAX_ROUTE_DESTINATION_CANDIDATES:
                gateway_pool = [
                    item
                    for item in candidates
                    if item[0].gateway
                    and item[0].can_end_trip
                    and item[0] not in choices
                    and item[0].corridor_id != origin.corridor_id
                ]
                if gateway_pool:
                    choices.append(
                        min(
                            gateway_pool,
                            key=lambda item: (
                                abs(item[1] - 6_000.0**2),
                                item[0].poi.id,
                            ),
                        )[0]
                    )

            while len(choices) < MAX_ROUTE_DESTINATION_CANDIDATES:
                remaining = [
                    item for item in candidates if item[0] not in choices
                ]
                if not remaining:
                    break
                used_sectors = {
                    item[2] for item in candidates if item[0] in choices
                }
                target = 1_100.0 if mode == "pedestrian" else 3_800.0
                chosen = min(
                    remaining,
                    key=lambda item: (
                        item[2] in used_sectors,
                        item[0].branch_depth_meters > 500.0
                        and self._poi_attraction_score(item[0].poi)
                        < IMPORTANT_HOTSPOT_MIN_SCORE,
                        abs(item[1] - target * target),
                        item[0].poi.category == origin.poi.category,
                        -self._poi_attraction_score(item[0].poi),
                        item[0].poi.id,
                    ),
                )[0]
                choices.append(chosen)
            successors[origin.poi.id] = tuple(choices)
        return successors

    def _snap_route_poi(self, poi: NetworkPOI, mode: str) -> SnappedPOI | None:
        node_id = self.network.nearest_node(
            poi.latitude,
            poi.longitude,
            mode,
            max_distance_meters=MAX_POI_SNAP_METERS[mode],
            prefer_suitable_highway=True,
            allowed_node_ids=self.network.routing_core_nodes[mode],
        )
        if node_id is None:
            return None
        node = self.network.nodes[node_id]
        distance = haversine_distance(
            (poi.latitude, poi.longitude),
            (node.latitude, node.longitude),
        )
        return SnappedPOI(
            poi=poi,
            node_id=node_id,
            snap_distance_meters=distance,
            branch_depth_meters=self.network.branch_depth_meters[mode].get(
                node_id, 0.0
            ),
        )

    @staticmethod
    def _poi_is_route_destination(poi: NetworkPOI, mode: str) -> bool:
        if poi.category not in ROUTE_POI_CATEGORIES:
            return False
        if poi.subtype in EXCLUDED_ROUTE_POI_SUBTYPES:
            return False
        if poi.category == "other" and not poi.has_name:
            return False
        if poi.category == "transit" and poi.subtype in {"platform", "stop_area"}:
            return poi.has_name
        if mode == "car" and poi.subtype in {
            "bicycle_rental",
            "bicycle_repair_station",
        }:
            return False
        return True

    @staticmethod
    def _poi_supports_route_mode(poi: NetworkPOI, mode: str) -> bool:
        if mode in poi.trip_modes:
            return True
        # The downloaded snapshot correctly marks transit objects as walkable,
        # but major stations are also realistic car drop-off / pick-up goals.
        return (
            mode == "car"
            and poi.category == "transit"
            and poi.subtype in MAJOR_TRANSIT_CAR_DESTINATIONS
            and poi.has_name
        )

    @staticmethod
    def _poi_attraction_score(poi: NetworkPOI) -> float:
        score = ROUTE_POI_CATEGORY_ATTRACTION.get(poi.category, 1.0)
        score += ROUTE_POI_SUBTYPE_ATTRACTION.get(poi.subtype, 0.0)
        score += min(8.0, max(0.0, poi.weight))
        if poi.has_name:
            score += 4.0
        if poi.osm_type in {"way", "relation"} and poi.category in {
            "shopping",
            "health",
            "education",
            "leisure",
            "transit",
        }:
            score += 5.0
        return score

    def _select_diverse_poi_anchors(
        self, mode: str
    ) -> tuple[list[SnappedPOI], dict[str, int]]:
        buckets: dict[tuple[int, int], dict[str, list[NetworkPOI]]] = {}
        eligible_count = 0
        for poi in self.network.pois:
            if not self._poi_supports_route_mode(
                poi, mode
            ) or not self._poi_is_route_destination(poi, mode):
                continue
            eligible_count += 1
            cell = self._route_grid_cell(poi.latitude, poi.longitude)
            buckets.setdefault(cell, {}).setdefault(poi.category, []).append(poi)
        for category_buckets in buckets.values():
            for pois in category_buckets.values():
                pois.sort(
                    key=lambda poi: (
                        -self._poi_attraction_score(poi),
                        not poi.has_name,
                        poi.id,
                    )
                )

        # Cellánként két eltérő kategóriájú jelölt, valamint a globális
        # hotspotok kerülnek snapelésre. Ez a 20x20-as lefedettséget úgy növeli,
        # hogy induláskor továbbra sem kell több ezer nearest-node keresés.
        shortlist: list[tuple[tuple[int, int], NetworkPOI]] = []
        for cell in sorted(buckets):
            cell_candidates = [
                pois[0]
                for pois in buckets[cell].values()
                if pois
            ]
            cell_candidates.sort(
                key=lambda poi: (
                    -self._poi_attraction_score(poi),
                    not poi.has_name,
                    poi.id,
                )
            )
            shortlist.extend(
                (cell, poi) for poi in cell_candidates[:2]
            )
        hotspot_records = sorted(
            (
                (
                    self._route_grid_cell(poi.latitude, poi.longitude),
                    poi,
                )
                for category_buckets in buckets.values()
                for pois in category_buckets.values()
                for poi in pois
                if self._poi_attraction_score(poi)
                >= IMPORTANT_HOTSPOT_MIN_SCORE
            ),
            key=lambda item: (
                -self._poi_attraction_score(item[1]),
                item[1].id,
            ),
        )
        existing_shortlist_ids = {poi.id for _, poi in shortlist}
        for cell, poi in hotspot_records[:160]:
            if poi.id not in existing_shortlist_ids:
                shortlist.append((cell, poi))
                existing_shortlist_ids.add(poi.id)
        for cell, category_buckets in sorted(buckets.items()):
            for pois in category_buckets.values():
                for poi in pois[:2]:
                    if (
                        self._poi_attraction_score(poi)
                        >= IMPORTANT_HOTSPOT_MIN_SCORE
                        and poi.id not in existing_shortlist_ids
                    ):
                        shortlist.append((cell, poi))
                        existing_shortlist_ids.add(poi.id)
        shortlist.sort(
            key=lambda item: (
                -self._poi_attraction_score(item[1]),
                item[0],
                item[1].id,
            )
        )

        snapped_by_cell: dict[tuple[int, int], list[SnappedPOI]] = {}
        rejected_snap_count = 0
        duplicate_snap_nodes = 0
        seen_nodes: set[int] = set()
        for cell, poi in shortlist:
            snapped = self._snap_route_poi(poi, mode)
            if snapped is None:
                rejected_snap_count += 1
                continue
            if snapped.node_id in seen_nodes:
                duplicate_snap_nodes += 1
                continue
            seen_nodes.add(snapped.node_id)
            snapped_by_cell.setdefault(cell, []).append(snapped)

        selected: list[SnappedPOI] = []
        selected_ids: set[str] = set()
        category_counts: dict[str, int] = {}
        maximum_anchors = MAX_ROUTE_POIS_BY_MODE[mode]

        # Large stations, malls, hospitals, universities and parks must not
        # lose to a small object merely because its OSM id sorts earlier.
        hotspot_candidates = sorted(
            (
                anchor
                for anchors in snapped_by_cell.values()
                for anchor in anchors
                if self._poi_attraction_score(anchor.poi)
                >= IMPORTANT_HOTSPOT_MIN_SCORE
            ),
            key=lambda anchor: (
                -self._poi_attraction_score(anchor.poi),
                anchor.snap_distance_meters,
                anchor.poi.id,
            ),
        )
        for anchor in hotspot_candidates:
            if len(selected) >= min(
                maximum_anchors, MAX_IMPORTANT_HOTSPOTS_BY_MODE[mode]
            ):
                break
            if any(
                haversine_distance(
                    (anchor.poi.latitude, anchor.poi.longitude),
                    (other.poi.latitude, other.poi.longitude),
                )
                < IMPORTANT_HOTSPOT_SEPARATION_METERS
                for other in selected
            ):
                continue
            selected.append(anchor)
            selected_ids.add(anchor.poi.id)
            category_counts[anchor.poi.category] = (
                category_counts.get(anchor.poi.category, 0) + 1
            )

        # Első kör: minden elérhető földrajzi cellából egy célpont.
        for cell in sorted(snapped_by_cell):
            if any(
                self._route_grid_cell(
                    anchor.poi.latitude, anchor.poi.longitude
                )
                == cell
                for anchor in selected
            ):
                continue
            choices = sorted(
                (
                    anchor
                    for anchor in snapped_by_cell[cell]
                    if anchor.poi.id not in selected_ids
                    and all(anchor.node_id != other.node_id for other in selected)
                ),
                key=lambda anchor: (
                    category_counts.get(anchor.poi.category, 0),
                    anchor.branch_depth_meters > 250.0,
                    -self._poi_attraction_score(anchor.poi),
                    not anchor.poi.has_name,
                    anchor.snap_distance_meters,
                    anchor.poi.id,
                ),
            )
            if not choices:
                continue
            chosen = choices[0]
            selected.append(chosen)
            selected_ids.add(chosen.poi.id)
            category_counts[chosen.poi.category] = (
                category_counts.get(chosen.poi.category, 0) + 1
            )
            if len(selected) >= maximum_anchors:
                break

        remaining = [
            anchor
            for cell in sorted(snapped_by_cell)
            for anchor in snapped_by_cell[cell]
            if anchor.poi.id not in selected_ids
        ]
        south, _, north, _ = self._network_bounds()
        longitude_scale = 111_000.0 * cos(radians((south + north) / 2))
        projected_positions = {
            anchor.poi.id: (
                anchor.poi.longitude * longitude_scale,
                anchor.poi.latitude * 110_900.0,
            )
            for anchor in [
                *selected,
                *remaining,
            ]
        }
        minimum_spacing_squared_by_id: dict[str, float] = {}
        for anchor in remaining:
            anchor_x, anchor_y = projected_positions[anchor.poi.id]
            minimum_spacing_squared = float("inf")
            for other in selected:
                other_x, other_y = projected_positions[other.poi.id]
                delta_x = anchor_x - other_x
                delta_y = anchor_y - other_y
                minimum_spacing_squared = min(
                    minimum_spacing_squared,
                    delta_x * delta_x + delta_y * delta_y,
                )
            minimum_spacing_squared_by_id[anchor.poi.id] = (
                minimum_spacing_squared
            )

        while remaining and len(selected) < maximum_anchors:
            separated = [
                anchor
                for anchor in remaining
                if minimum_spacing_squared_by_id[anchor.poi.id]
                >= MIN_POI_ANCHOR_SEPARATION_METERS**2
            ]
            pool = separated or remaining
            chosen = min(
                pool,
                key=lambda anchor: (
                    anchor.branch_depth_meters > 250.0,
                    category_counts.get(anchor.poi.category, 0),
                    -minimum_spacing_squared_by_id[anchor.poi.id],
                    -self._poi_attraction_score(anchor.poi),
                    not anchor.poi.has_name,
                    anchor.snap_distance_meters,
                    anchor.poi.id,
                ),
            )
            selected.append(chosen)
            selected_ids.add(chosen.poi.id)
            category_counts[chosen.poi.category] = (
                category_counts.get(chosen.poi.category, 0) + 1
            )
            remaining = [
                anchor
                for anchor in remaining
                if anchor.poi.id != chosen.poi.id
                and anchor.node_id != chosen.node_id
            ]
            chosen_x, chosen_y = projected_positions[chosen.poi.id]
            for anchor in remaining:
                anchor_x, anchor_y = projected_positions[anchor.poi.id]
                delta_x = anchor_x - chosen_x
                delta_y = anchor_y - chosen_y
                minimum_spacing_squared_by_id[anchor.poi.id] = min(
                    minimum_spacing_squared_by_id[anchor.poi.id],
                    delta_x * delta_x + delta_y * delta_y,
                )
        return selected, {
            "eligibleCandidates": eligible_count,
            "shortlistCandidates": len(shortlist),
            "snappableCatalogCandidates": len(seen_nodes),
            "rejectedSnapCandidates": rejected_snap_count,
            "duplicateSnapNodes": duplicate_snap_nodes,
            "catalogGridCells": len(snapped_by_cell),
            "importantHotspotAnchors": sum(
                self._poi_attraction_score(anchor.poi)
                >= IMPORTANT_HOTSPOT_MIN_SCORE
                for anchor in selected
            ),
        }

    def _gateway_side(self, node_id: int) -> str:
        south, west, north, east = self._network_bounds()
        node = self.network.nodes[node_id]
        latitude_span = max(1e-9, north - south)
        longitude_span = max(1e-9, east - west)
        distances = {
            "west": (node.longitude - west) / longitude_span,
            "east": (east - node.longitude) / longitude_span,
            "south": (node.latitude - south) / latitude_span,
            "north": (north - node.latitude) / latitude_span,
        }
        return min(distances, key=lambda side: (distances[side], side))

    def _make_gateway_anchor(
        self,
        mode: str,
        node_id: int,
        highway: str,
        *,
        portal_role: str,
        corridor_id: str,
    ) -> SnappedPOI:
        node = self.network.nodes[node_id]
        side = self._gateway_side(node_id)
        side_names = {
            "north": "Északi",
            "east": "Keleti",
            "south": "Déli",
            "west": "Nyugati",
        }
        role_names = {
            "source": "belépési",
            "sink": "kilépési",
            "both": "forgalmi",
        }
        gateway_kind = "főúti" if mode == "car" else "gyalogos"
        poi = NetworkPOI(
            id=f"gateway/{mode}/{portal_role}/{node_id}",
            osm_type="synthetic",
            osm_id=node_id,
            latitude=node.latitude,
            longitude=node.longitude,
            name=(
                f"{side_names[side]} {highway} {role_names[portal_role]} kapu"
            ),
            category="gateway",
            subtype=highway,
            tags={
                "boundary": side,
                "highway": highway,
                "portalRole": portal_role,
                "corridor": corridor_id,
            },
            trip_modes=frozenset({mode}),
            weight=8.0 if gateway_kind == "főúti" else 5.0,
            has_name=True,
        )
        return SnappedPOI(
            poi=poi,
            node_id=node_id,
            snap_distance_meters=0.0,
            gateway=True,
            portal_role=portal_role,
            corridor_id=corridor_id,
            branch_depth_meters=self.network.branch_depth_meters[mode].get(
                node_id, 0.0
            ),
        )

    def _topology_gateway_anchors(
        self, mode: str, used_nodes: set[int]
    ) -> list[SnappedPOI]:
        """Find directed high-order tails outside the main routing SCC.

        These tails represent the motorway and bridge carriageways that the
        district cut turns into source-only or sink-only graph fragments.
        """

        if mode != "car":
            return []
        core = self.network.routing_core_nodes[mode]
        road_rank = {
            "motorway": 0,
            "motorway_link": 1,
            "trunk": 2,
            "trunk_link": 3,
            "primary": 4,
            "primary_link": 5,
            "secondary": 6,
            "secondary_link": 7,
        }
        major_edges = tuple(
            edge
            for edge in self.network.edges_by_mode[mode]
            if edge.highway in MAJOR_GATEWAY_HIGHWAYS
        )
        outside_nodes = {
            node_id
            for edge in major_edges
            for node_id in (edge.from_node, edge.to_node)
            if node_id not in core
        }
        adjacency: dict[int, set[int]] = {
            node_id: set() for node_id in outside_nodes
        }
        forward: dict[int, set[int]] = {node_id: set() for node_id in outside_nodes}
        reverse: dict[int, set[int]] = {node_id: set() for node_id in outside_nodes}
        for edge in major_edges:
            if edge.from_node in outside_nodes and edge.to_node in outside_nodes:
                adjacency[edge.from_node].add(edge.to_node)
                adjacency[edge.to_node].add(edge.from_node)
                forward[edge.from_node].add(edge.to_node)
                reverse[edge.to_node].add(edge.from_node)

        components: list[set[int]] = []
        unseen = set(outside_nodes)
        while unseen:
            start = min(unseen)
            component: set[int] = set()
            stack = [start]
            while stack:
                node_id = stack.pop()
                if node_id in component:
                    continue
                component.add(node_id)
                unseen.discard(node_id)
                stack.extend(adjacency.get(node_id, ()) - component)
            components.append(component)

        def reachable(
            starts: set[int], links: dict[int, set[int]], component: set[int]
        ) -> set[int]:
            visited: set[int] = set()
            stack = list(starts)
            while stack:
                node_id = stack.pop()
                if node_id in visited or node_id not in component:
                    continue
                visited.add(node_id)
                stack.extend(links.get(node_id, ()) - visited)
            return visited

        def far_endpoint(
            nodes: set[int], frontier: set[int], *, source: bool
        ) -> tuple[int, float]:
            if not nodes:
                raise ValueError("Üres gateway-farok.")
            terminal = [
                node_id
                for node_id in nodes
                if not (
                    (reverse if source else forward).get(node_id, set()) & nodes
                )
            ]
            candidates = terminal or sorted(nodes)

            def distance_from_frontier(node_id: int) -> float:
                x, y = self.network.projected_node_positions[node_id]
                return min(
                    hypot(
                        x - self.network.projected_node_positions[other][0],
                        y - self.network.projected_node_positions[other][1],
                    )
                    for other in frontier
                )

            node_id = max(
                candidates,
                key=lambda candidate: (
                    distance_from_frontier(candidate),
                    -candidate,
                ),
            )
            return node_id, distance_from_frontier(node_id)

        candidates: list[tuple[int, float, str, int, str]] = []
        for component in components:
            entry_edges = [
                edge
                for edge in major_edges
                if edge.from_node in component and edge.to_node in core
            ]
            exit_edges = [
                edge
                for edge in major_edges
                if edge.from_node in core and edge.to_node in component
            ]
            component_highways = [
                edge.highway
                for edge in major_edges
                if edge.from_node in component or edge.to_node in component
            ]
            corridor_id = f"frontier-{min(component)}"
            if entry_edges:
                frontier = {edge.from_node for edge in entry_edges}
                tail_nodes = reachable(frontier, reverse, component)
                node_id, tail_length = far_endpoint(
                    tail_nodes, frontier, source=True
                )
                highway = min(
                    component_highways,
                    key=lambda value: (road_rank[value], value),
                )
                candidates.append(
                    (road_rank[highway], -tail_length, "source", node_id, corridor_id)
                )
            if exit_edges:
                frontier = {edge.to_node for edge in exit_edges}
                tail_nodes = reachable(frontier, forward, component)
                node_id, tail_length = far_endpoint(
                    tail_nodes, frontier, source=False
                )
                highway = min(
                    component_highways,
                    key=lambda value: (road_rank[value], value),
                )
                candidates.append(
                    (road_rank[highway], -tail_length, "sink", node_id, corridor_id)
                )

        gateways: list[SnappedPOI] = []
        for rank, _, role, node_id, corridor_id in sorted(candidates):
            if node_id in used_nodes:
                continue
            node = self.network.nodes[node_id]
            if any(
                anchor.portal_role == role
                and haversine_distance(
                    (node.latitude, node.longitude),
                    (anchor.poi.latitude, anchor.poi.longitude),
                )
                < 180.0
                for anchor in gateways
            ):
                continue
            highway = next(
                highway
                for highway, highway_rank in road_rank.items()
                if highway_rank == rank
            )
            anchor = self._make_gateway_anchor(
                mode,
                node_id,
                highway,
                portal_role=role,
                corridor_id=corridor_id,
            )
            gateways.append(anchor)
            used_nodes.add(node_id)
            if len(gateways) >= 24:
                break
        return gateways

    def _fallback_gateway_anchors(
        self, mode: str, used_nodes: set[int]
    ) -> list[SnappedPOI]:
        south, west, north, east = self._network_bounds()
        latitude_span = max(1e-9, north - south)
        longitude_span = max(1e-9, east - west)
        incoming_nodes = {
            edge.to_node for edge in self.network.edges_by_mode[mode]
        }
        road_rank = (
            {
                "motorway": 0,
                "motorway_link": 1,
                "trunk": 2,
                "trunk_link": 3,
                "primary": 4,
                "primary_link": 5,
                "secondary": 6,
                "secondary_link": 7,
            }
            if mode == "car"
            else PEDESTRIAN_GATEWAY_HIGHWAY_RANK
        )
        side_candidates: dict[str, dict[int, tuple[float, int, str, int]]] = {
            side: {} for side in ("north", "east", "south", "west")
        }
        for edge in self.network.edges_by_mode[mode]:
            if edge.highway not in road_rank:
                continue
            node_id = edge.from_node
            if (
                node_id in used_nodes
                or node_id not in incoming_nodes
                or node_id not in self.network.routing_core_nodes[mode]
            ):
                continue
            node = self.network.nodes[node_id]
            normalized_x = (node.longitude - west) / longitude_span
            normalized_y = (node.latitude - south) / latitude_span
            distances = {
                "west": normalized_x,
                "east": 1.0 - normalized_x,
                "south": normalized_y,
                "north": 1.0 - normalized_y,
            }
            side = min(distances, key=lambda name: (distances[name], name))
            boundary_distance = max(0.0, distances[side])
            if boundary_distance > 0.14:
                continue
            score = boundary_distance + road_rank[edge.highway] * 0.015
            candidate = (score, road_rank[edge.highway], edge.highway, node_id)
            previous = side_candidates[side].get(edge.way_id)
            if previous is None or candidate < previous:
                side_candidates[side][edge.way_id] = candidate

        gateways: list[SnappedPOI] = []
        minimum_spacing = 600.0 if mode == "car" else 350.0
        for side in ("north", "east", "south", "west"):
            ordered = sorted(side_candidates[side].items(), key=lambda item: item[1])
            selected_nodes: list[int] = []
            for way_id, (_, _, highway, node_id) in ordered:
                if node_id in used_nodes:
                    continue
                node = self.network.nodes[node_id]
                if any(
                    haversine_distance(
                        (node.latitude, node.longitude),
                        (
                            self.network.nodes[other].latitude,
                            self.network.nodes[other].longitude,
                        ),
                    )
                    < minimum_spacing
                    for other in selected_nodes
                ):
                    continue
                gateways.append(
                    self._make_gateway_anchor(
                        mode,
                        node_id,
                        highway,
                        portal_role="both",
                        corridor_id=f"bbox-{side}-{way_id}",
                    )
                )
                selected_nodes.append(node_id)
                used_nodes.add(node_id)
                if len(selected_nodes) >= MAX_GATEWAYS_PER_SIDE_BY_MODE[mode]:
                    break
        return gateways

    def _gateway_anchors(
        self, mode: str, used_nodes: set[int]
    ) -> list[SnappedPOI]:
        gateways = self._topology_gateway_anchors(mode, used_nodes)
        if len(gateways) < 4:
            gateways.extend(self._fallback_gateway_anchors(mode, used_nodes))
        return gateways

    def _warm_route_cache(self) -> None:
        # Két irányban eltérő út előre elkészül minden origóhoz. A további,
        # jóval nagyobb OD-készlet lusta cache-ben épül fel a futás során.
        for mode in sorted(VALID_MODES):
            anchors = tuple(self.route_pois_by_mode[mode])
            initial_count = len(anchors)
            candidate_routes = sum(
                len(destinations)
                for destinations in self.route_successors[mode].values()
            )
            destination_count = sum(anchor.can_end_trip for anchor in anchors)
            required_successors = min(
                ROUTE_SUCCESSORS_PER_ORIGIN,
                min(
                    (
                        destination_count - int(anchor.can_end_trip)
                        for anchor in anchors
                        if anchor.can_start_trip
                    ),
                    default=0,
                ),
            )
            successful: dict[str, tuple[SnappedPOI, ...]] = {}
            failed_route_candidates = 0
            warmed_by_origin: dict[str, tuple[SnappedPOI, ...]] = {}
            if required_successors:
                for origin in anchors:
                    if not origin.can_start_trip:
                        continue
                    candidates = list(
                        self.route_successors[mode].get(origin.poi.id, ())
                    )
                    warm_choices: list[SnappedPOI] = []
                    same_direction: list[SnappedPOI] = []
                    failed_ids: set[str] = set()
                    first_segments: set[str] = set()
                    attempts = 0
                    for destination in candidates:
                        if (
                            attempts >= MAX_WARM_ROUTE_ATTEMPTS
                            and len(warm_choices) >= required_successors
                        ):
                            break
                        attempts += 1
                        route_edge_ids = self._cached_route(
                            mode, origin, destination
                        )
                        if not route_edge_ids:
                            failed_route_candidates += 1
                            failed_ids.add(destination.poi.id)
                            continue
                        first_segment = self.network.edges_by_id[
                            route_edge_ids[0]
                        ].segment_id
                        if first_segment in first_segments:
                            same_direction.append(destination)
                        else:
                            warm_choices.append(destination)
                            first_segments.add(first_segment)
                        if len(warm_choices) >= required_successors:
                            break
                    if len(warm_choices) < required_successors:
                        warm_choices.extend(
                            same_direction[
                                : required_successors - len(warm_choices)
                            ]
                        )
                    if len(warm_choices) < required_successors:
                        continue
                    retained = [
                        destination
                        for destination in candidates
                        if destination.poi.id not in failed_ids
                    ]
                    successful[origin.poi.id] = tuple(retained)
                    warmed_by_origin[origin.poi.id] = tuple(warm_choices)

            viable_origin_ids = set(successful)
            referenced_ids = {
                destination.poi.id
                for destinations in successful.values()
                for destination in destinations
            }
            active_ids = viable_origin_ids | referenced_ids
            viable_origins = tuple(
                anchor for anchor in anchors if anchor.poi.id in active_ids
            )
            self.route_successors[mode] = successful
            self.route_pois_by_mode[mode] = viable_origins
            self.route_pois_by_id[mode] = {
                anchor.poi.id: anchor for anchor in viable_origins
            }
            self.route_selection_stats[mode]["viableAnchors"] = len(
                viable_origins
            )
            self.route_selection_stats[mode]["viableGatewayAnchors"] = sum(
                anchor.gateway for anchor in viable_origins
            )
            self.route_selection_stats[mode]["viableOrigins"] = len(
                viable_origin_ids
            )
            self.route_selection_stats[mode]["sourceGatewayAnchors"] = sum(
                anchor.gateway and anchor.can_start_trip
                for anchor in viable_origins
            )
            self.route_selection_stats[mode]["sinkGatewayAnchors"] = sum(
                anchor.gateway and anchor.can_end_trip
                for anchor in viable_origins
            )
            self.route_selection_stats[mode]["branchAnchors"] = sum(
                anchor.branch_depth_meters > 0.0
                for anchor in viable_origins
                if not anchor.gateway
            )
            self.route_selection_stats[mode]["deepBranchAnchors"] = sum(
                anchor.branch_depth_meters > 250.0
                for anchor in viable_origins
                if not anchor.gateway
            )
            viable_gateway_highways = {
                anchor.poi.subtype
                for anchor in viable_origins
                if anchor.gateway
            }
            self.route_selection_stats[mode]["gatewayHighways"] = {
                highway: sum(
                    anchor.gateway and anchor.poi.subtype == highway
                    for anchor in viable_origins
                )
                for highway in sorted(viable_gateway_highways)
            }
            self.route_selection_stats[mode]["viableGridCells"] = len(
                {
                    self._route_grid_cell(
                        anchor.poi.latitude, anchor.poi.longitude
                    )
                    for anchor in viable_origins
                    if not anchor.gateway
                }
            )
            self.route_selection_stats[mode]["cachedRoutes"] = sum(
                bool(
                    self.route_cache.get(
                        (mode, origin_id, destination.poi.id)
                    )
                )
                for origin_id, destinations in successful.items()
                for destination in destinations
            )
            self.route_selection_stats[mode]["rejectedRouteAnchors"] = (
                initial_count - len(viable_origins)
            )
            self.route_selection_stats[mode]["candidateRoutes"] = candidate_routes
            self.route_selection_stats[mode]["failedRouteCandidates"] = (
                failed_route_candidates
            )
            successor_counts = [
                len(destinations) for destinations in successful.values()
            ]
            warmed_counts = [
                len(destinations) for destinations in warmed_by_origin.values()
            ]
            self.route_selection_stats[mode]["successorMinimum"] = min(
                successor_counts, default=0
            )
            self.route_selection_stats[mode]["successorMaximum"] = max(
                successor_counts, default=0
            )
            self.route_selection_stats[mode]["activeOdPairs"] = sum(
                successor_counts
            )
            self.route_selection_stats[mode]["warmSuccessorMinimum"] = min(
                warmed_counts, default=0
            )

            active_route_edge_ids: set[str] = set()
            route_lengths: list[float] = []
            route_edge_counts: Counter[str] = Counter()
            for origin_id, destinations in successful.items():
                for destination in destinations:
                    route_edge_ids = self.route_cache.get(
                        (mode, origin_id, destination.poi.id), ()
                    ) or ()
                    if not route_edge_ids:
                        continue
                    active_route_edge_ids.update(route_edge_ids)
                    route_edge_counts.update(route_edge_ids)
                    route_lengths.append(
                        sum(
                            self.network.edges_by_id[edge_id].length_meters
                            for edge_id in route_edge_ids
                        )
                    )
            route_lengths.sort()

            def percentile(values: list[float], fraction: float) -> float:
                if not values:
                    return 0.0
                index = int(round((len(values) - 1) * fraction))
                return values[int(_clamp(index, 0, len(values) - 1))]

            local_limit = 2_000.0 if mode == "pedestrian" else 3_000.0
            medium_limit = 4_000.0 if mode == "pedestrian" else 7_000.0
            self.route_selection_stats[mode]["localRoutes"] = sum(
                length < local_limit for length in route_lengths
            )
            self.route_selection_stats[mode]["mediumRoutes"] = sum(
                local_limit <= length < medium_limit for length in route_lengths
            )
            self.route_selection_stats[mode]["farRoutes"] = sum(
                length >= medium_limit for length in route_lengths
            )
            self.route_selection_stats[mode]["routeMedianMeters"] = percentile(
                route_lengths, 0.5
            )
            self.route_selection_stats[mode]["routeP90Meters"] = percentile(
                route_lengths, 0.9
            )
            self.route_selection_stats[mode]["routeEdges"] = len(
                active_route_edge_ids
            )
            mode_edges = self.network.edges_by_mode[mode]
            self.route_selection_stats[mode]["routeEdgeCoveragePercent"] = (
                100.0 * len(active_route_edge_ids) / len(mode_edges)
            )
            total_route_edge_uses = sum(route_edge_counts.values())
            ordered_counts = sorted(route_edge_counts.values(), reverse=True)

            def top_share(fraction: float) -> float:
                if not ordered_counts or total_route_edge_uses <= 0:
                    return 0.0
                count = max(1, int(round(len(mode_edges) * fraction)))
                return 100.0 * sum(ordered_counts[:count]) / total_route_edge_uses

            all_counts = sorted(
                route_edge_counts.get(edge.id, 0) for edge in mode_edges
            )
            weighted_sum = sum(
                index * value
                for index, value in enumerate(all_counts, start=1)
            )
            gini = (
                (2.0 * weighted_sum)
                / (len(all_counts) * sum(all_counts))
                - (len(all_counts) + 1.0) / len(all_counts)
                if all_counts and sum(all_counts) > 0
                else 0.0
            )
            self.route_selection_stats[mode]["unusedRouteEdgePercent"] = (
                100.0 * (len(mode_edges) - len(active_route_edge_ids)) / len(mode_edges)
            )
            self.route_selection_stats[mode]["topOnePercentUseShare"] = top_share(
                0.01
            )
            self.route_selection_stats[mode]["topFivePercentUseShare"] = top_share(
                0.05
            )
            self.route_selection_stats[mode]["routeUseGini"] = gini
            route_fine_cells = {
                self._fine_grid_cell(
                    (
                        self.network.edges_by_id[edge_id].start[0]
                        + self.network.edges_by_id[edge_id].end[0]
                    )
                    / 2,
                    (
                        self.network.edges_by_id[edge_id].start[1]
                        + self.network.edges_by_id[edge_id].end[1]
                    )
                    / 2,
                )
                for edge_id in active_route_edge_ids
            }
            network_fine_cells = {
                self._fine_grid_cell(
                    (edge.start[0] + edge.end[0]) / 2,
                    (edge.start[1] + edge.end[1]) / 2,
                )
                for edge in mode_edges
            }
            self.route_selection_stats[mode]["routeFineCells"] = len(
                route_fine_cells
            )
            self.route_selection_stats[mode]["networkFineCells"] = len(
                network_fine_cells
            )
            if mode == "pedestrian":
                route_major_edges = sum(
                    self.network.edges_by_id[edge_id].highway
                    in PEDESTRIAN_MAJOR_HIGHWAYS
                    for edge_id in active_route_edge_ids
                )
                network_major_edges = sum(
                    edge.highway in PEDESTRIAN_MAJOR_HIGHWAYS
                    for edge in mode_edges
                )
                self.route_selection_stats[mode]["majorRouteEdgePercent"] = (
                    100.0 * route_major_edges / max(1, len(active_route_edge_ids))
                )
                self.route_selection_stats[mode]["majorNetworkEdgePercent"] = (
                    100.0 * network_major_edges / len(mode_edges)
                )
        self.route_cache_ready = True

    def set_agent_targets(self, *, cars: int, pedestrians: int) -> None:
        self._reconcile("car", int(_clamp(int(cars), 0, 5_000)))
        self._reconcile("pedestrian", int(_clamp(int(pedestrians), 0, 5_000)))

    def _reconcile(self, mode: str, target: int) -> None:
        existing = [agent for agent in self.agents if agent.mode == mode]
        if len(existing) > target:
            remove_ids = {agent.id for agent in existing[target:]}
            self.agents = [agent for agent in self.agents if agent.id not in remove_ids]
            return
        car_edge_counts: Counter[str] = Counter()
        car_lane_positions: dict[tuple[str, int], dict[int, float]] = {}
        car_headway_reservations: dict[tuple[str, int], float] = {}
        car_merge_positions: dict[tuple[str, int], list[float]] = {}
        if mode == "car":
            for agent in existing:
                car_edge_counts[agent.edge.id] += 1
                car_lane_positions.setdefault(
                    (agent.edge.id, agent.lane_index), {}
                )[agent.id] = agent.distance_meters
                for edge_id, lane_index, reserved_distance in (
                    self._initial_headway_reservations(agent)
                ):
                    key = (edge_id, lane_index)
                    car_headway_reservations[key] = max(
                        car_headway_reservations.get(key, 0.0),
                        reserved_distance,
                    )
                for merge_key, merge_coordinate, _ in (
                    self._merge_approach_slots(agent, CAR_LENGTH_METERS)
                ):
                    car_merge_positions.setdefault(merge_key, []).append(
                        merge_coordinate
                    )
        for _ in range(len(existing), target):
            candidate: NetworkAgent | None = None
            attempts = 96 if mode == "car" else 1
            for _ in range(attempts):
                created_candidate = self._create_agent(mode)
                if mode != "car":
                    candidate = created_candidate
                    break
                if (
                    car_edge_counts[created_candidate.edge.id]
                    >= self._edge_vehicle_capacity(created_candidate.edge)
                ):
                    continue
                positions = car_lane_positions.get(
                    (created_candidate.edge.id, created_candidate.lane_index), {}
                )
                if any(
                    abs(created_candidate.distance_meters - position)
                    < CAR_LENGTH_METERS
                    for position in positions.values()
                ):
                    continue
                if (
                    created_candidate.distance_meters
                    < car_headway_reservations.get(
                        (
                            created_candidate.edge.id,
                            created_candidate.lane_index,
                        ),
                        0.0,
                    )
                    - 1e-9
                ):
                    continue
                merge_slots = self._merge_approach_slots(
                    created_candidate, CAR_LENGTH_METERS
                )
                if any(
                    any(
                        abs(merge_coordinate - existing_coordinate)
                        < CAR_LENGTH_METERS
                        for existing_coordinate in car_merge_positions.get(
                            merge_key, ()
                        )
                    )
                    for merge_key, merge_coordinate, _ in merge_slots
                ):
                    continue
                next_edge = self.network.edges_by_id.get(
                    created_candidate.planned_edge_id or ""
                )
                if (
                    next_edge is not None
                    and created_candidate.edge.length_meters
                    - created_candidate.distance_meters
                    < CAR_LENGTH_METERS
                ):
                    lane_options = self._lane_options_after_entry(
                        created_candidate, next_edge
                    )
                    next_lane = self._mapped_lane_for_transition(
                        created_candidate.edge,
                        created_candidate.lane_index,
                        next_edge,
                        lane_options,
                    )
                    rear_distance = self._downstream_rear_distance(
                        created_candidate,
                        next_edge,
                        next_lane,
                        car_lane_positions,
                    )
                    if (
                        rear_distance is not None
                        and created_candidate.edge.length_meters
                        - created_candidate.distance_meters
                        + rear_distance
                        < CAR_LENGTH_METERS - 1e-9
                    ):
                        continue
                candidate = created_candidate
                break
            if candidate is None:
                continue
            self.agents.append(candidate)
            if mode == "car":
                car_edge_counts[candidate.edge.id] += 1
                car_lane_positions.setdefault(
                    (candidate.edge.id, candidate.lane_index), {}
                )[candidate.id] = candidate.distance_meters
                for edge_id, lane_index, reserved_distance in (
                    self._initial_headway_reservations(candidate)
                ):
                    key = (edge_id, lane_index)
                    car_headway_reservations[key] = max(
                        car_headway_reservations.get(key, 0.0),
                        reserved_distance,
                    )
                for merge_key, merge_coordinate, _ in (
                    self._merge_approach_slots(candidate, CAR_LENGTH_METERS)
                ):
                    car_merge_positions.setdefault(merge_key, []).append(
                        merge_coordinate
                    )

    def _edge_weight(self, edge: NetworkEdge, mode: str) -> float:
        if mode == "pedestrian":
            return {
                "pedestrian": 7,
                "footway": 5,
                "path": 3,
                "living_street": 3,
                "residential": 2,
            }.get(edge.highway, 1)
        return {
            "motorway": 8,
            "trunk": 7,
            "primary": 6,
            "secondary": 4,
            "tertiary": 3,
            "unclassified": 2,
            "residential": 1.4,
        }.get(edge.highway, 0.8)

    def _random_edge(self, mode: str) -> NetworkEdge:
        edges = self.network.edges_by_mode[mode]
        # A teljes listás weights felépítés minden új ágensnél drága lenne; a
        # rejection sampling megtartja a főutak nagyobb indulási esélyét.
        for _ in range(20):
            edge = self.random.choice(edges)
            if self.random.random() * 8 <= self._edge_weight(edge, mode):
                return edge
        return self.random.choice(edges)

    def _create_agent(self, mode: str) -> NetworkAgent:
        route = self._initial_poi_route(mode)
        if route is None:
            edge = self._random_edge(mode)
            route_edge_ids: tuple[str, ...] = ()
            route_index = 0
            origin_poi = None
            destination_poi = None
            origin_snap_distance_meters = 0.0
            destination_snap_distance_meters = 0.0
            origin_poi_kind = "poi"
            destination_poi_kind = "poi"
            distance_meters = self.random.random() * edge.length_meters
            way_history = (edge.way_id,)
        else:
            origin, destination, route_edge_ids = route
            # Meleg indítás: az ágensek nem egyetlen POI-ra torlódva jelennek meg,
            # de ugyanazt a valódi A-B útvonalat fejezik be.
            route_index = self.random.randrange(len(route_edge_ids))
            edge = self.network.edges_by_id[route_edge_ids[route_index]]
            distance_meters = self.random.random() * edge.length_meters
            origin_poi = origin.poi
            destination_poi = destination.poi
            origin_snap_distance_meters = origin.snap_distance_meters
            destination_snap_distance_meters = destination.snap_distance_meters
            origin_poi_kind = "gateway" if origin.gateway else "poi"
            destination_poi_kind = "gateway" if destination.gateway else "poi"
            way_history = self._route_history(route_edge_ids, route_index)
        free_flow_speed_ratio = (
            0.82 + self.random.random() * 0.18
            if mode == "car"
            else None
        )
        agent = NetworkAgent(
            id=self.next_agent_id,
            mode=mode,
            edge=edge,
            distance_meters=distance_meters,
            desired_speed_mps=self._desired_speed(
                edge, mode, free_flow_speed_ratio
            ),
            current_speed_mps=0.0,
            lane_index=self.random.randrange(edge.lanes),
            planned_edge_id=None,
            trip_target_meters=self._trip_target(mode),
            way_history=way_history,
            route_edge_ids=route_edge_ids,
            route_index=route_index,
            origin_poi=origin_poi,
            destination_poi=destination_poi,
            origin_snap_distance_meters=origin_snap_distance_meters,
            destination_snap_distance_meters=destination_snap_distance_meters,
            origin_poi_kind=origin_poi_kind,
            destination_poi_kind=destination_poi_kind,
            free_flow_speed_ratio=free_flow_speed_ratio,
        )
        self.next_agent_id += 1
        self._plan_next(agent)
        return agent

    def _route_history(
        self, route_edge_ids: tuple[str, ...], route_index: int
    ) -> tuple[int, ...]:
        history: tuple[int, ...] = ()
        for edge_id in route_edge_ids[: route_index + 1]:
            edge = self.network.edges_by_id[edge_id]
            history = self.network.extend_way_history(history, edge.way_id)
        return history

    def _cached_route(
        self, mode: str, origin: SnappedPOI, destination: SnappedPOI
    ) -> tuple[str, ...] | None:
        key = (mode, origin.poi.id, destination.poi.id)
        if key in self.route_cache:
            return self.route_cache[key]
        route = self.network.shortest_route(
            origin.node_id,
            destination.node_id,
            mode,
            segment_usage=self.route_segment_usage[mode],
            reuse_penalty=ROUTE_REUSE_PENALTY[mode],
        )
        route_ids = tuple(edge.id for edge in route) if route else None
        if len(self.route_cache) >= MAX_ROUTE_CACHE_ENTRIES:
            self.route_cache.pop(next(iter(self.route_cache)))
        self.route_cache[key] = route_ids
        if route_ids:
            self.route_segment_usage[mode].update(
                self.network.edges_by_id[edge_id].segment_id
                for edge_id in route_ids
            )
        return route_ids

    def _choose_poi_route(
        self,
        mode: str,
        origin: SnappedPOI,
        *,
        incoming_edge: NetworkEdge | None = None,
        way_history: tuple[int, ...] = (),
        cached_only: bool = False,
    ) -> tuple[SnappedPOI, tuple[str, ...]] | None:
        choices = list(self.route_successors[mode].get(origin.poi.id, ()))
        allowed_first_ids: set[str] | None = None
        if incoming_edge is not None:
            allowed_first_ids = {
                edge.id
                for edge in self.network.allowed_outgoing(
                    incoming_edge, mode, way_history
                )
            }
        while choices:
            counts = [
                self.route_choice_counts[
                    (mode, origin.poi.id, destination.poi.id)
                ]
                for destination in choices
            ]
            minimum_count = min(counts, default=0)
            weights = []
            for destination, count in zip(choices, counts):
                attraction = (
                    18.0
                    if destination.gateway
                    else self._poi_attraction_score(destination.poi)
                )
                weights.append(
                    max(1.0, attraction) ** 0.5
                    / (1.0 + count - minimum_count)
                )
            destination = self.random.choices(choices, weights=weights, k=1)[0]
            choices.remove(destination)
            key = (mode, origin.poi.id, destination.poi.id)
            if cached_only and not self.route_cache.get(key):
                continue
            route_edge_ids = self._cached_route(mode, origin, destination)
            if not route_edge_ids:
                continue
            first_edge = self.network.edges_by_id[route_edge_ids[0]]
            if first_edge.from_node != origin.node_id:
                continue
            if allowed_first_ids is not None and first_edge.id not in allowed_first_ids:
                continue
            self.route_choice_counts[key] += 1
            return destination, route_edge_ids
        return None

    def _initial_poi_route(
        self, mode: str, *, prefer_gateway: bool = False
    ) -> tuple[SnappedPOI, SnappedPOI, tuple[str, ...]] | None:
        anchors = tuple(
            anchor
            for anchor in self.route_pois_by_mode[mode]
            if anchor.poi.id in self.route_successors[mode]
            and anchor.can_start_trip
            and (not prefer_gateway or anchor.gateway)
        )
        if prefer_gateway and not anchors:
            return self._initial_poi_route(mode)
        if not anchors:
            return None
        # Az indulás csak a két előmelegített irányból választ, ezért sok
        # horgonynál is gyors marad; további OD-k menet közben készülnek el.
        start = self.random.randrange(len(anchors))
        for offset in range(min(len(anchors), 16)):
            origin = anchors[(start + offset) % len(anchors)]
            selected = self._choose_poi_route(
                mode, origin, cached_only=True
            )
            if selected is not None:
                destination, route_edge_ids = selected
                return origin, destination, route_edge_ids
        return None

    def _desired_speed(
        self,
        edge: NetworkEdge,
        mode: str,
        free_flow_speed_ratio: float | None = None,
    ) -> float:
        if mode == "pedestrian":
            return 1.1 + self.random.random() * 0.55
        speed = edge.max_speed_kph / 3.6
        ratio = (
            free_flow_speed_ratio
            if free_flow_speed_ratio is not None
            else 0.82 + self.random.random() * 0.18
        )
        return _clamp(speed * ratio, 2.5, 36.0)

    def _desired_speed_for_agent(
        self, agent: NetworkAgent, edge: NetworkEdge
    ) -> float:
        if agent.mode != "car":
            return self._desired_speed(edge, agent.mode)
        ratio = agent.free_flow_speed_ratio
        if ratio is None:
            current_limit = max(1e-9, agent.edge.max_speed_kph / 3.6)
            ratio = _clamp(agent.desired_speed_mps / current_limit, 0.5, 1.2)
            agent.free_flow_speed_ratio = ratio
        return self._desired_speed(edge, agent.mode, ratio)

    def _trip_target(self, mode: str) -> float:
        return (
            2_000 + self.random.random() * 4_000
            if mode == "car"
            else 700 + self.random.random() * 1_800
        )

    def _poi_dwell_seconds(self, poi: NetworkPOI, mode: str) -> float:
        important = self._poi_attraction_score(poi) >= IMPORTANT_HOTSPOT_MIN_SCORE
        if mode == "pedestrian":
            base = 12.0 if important else 4.0
            return base + self.random.random() * (18.0 if important else 6.0)
        base = 7.0 if important else 2.0
        return base + self.random.random() * (9.0 if important else 4.0)

    @staticmethod
    def _nearest_lane(current_lane: int, lane_options: tuple[int, ...]) -> int:
        """Keep a compatible lane; otherwise make only the smallest needed move."""

        if current_lane in lane_options:
            return current_lane
        return min(
            lane_options,
            key=lambda lane_index: (
                abs(lane_index - current_lane),
                -lane_index,
            ),
        )

    def _plan_next(self, agent: NetworkAgent) -> None:
        if (
            agent.route_edge_ids
            and agent.route_index == len(agent.route_edge_ids) - 1
        ):
            # The arrival handler chooses the next trip at this edge's end.
            # Planning an unused random exit here only caused a spurious lane
            # change on the final approach.
            agent.planned_edge_id = None
            return
        if agent.route_edge_ids and agent.route_index + 1 < len(agent.route_edge_ids):
            candidate = self.network.edges_by_id[
                agent.route_edge_ids[agent.route_index + 1]
            ]
            allowed_ids = {
                edge.id
                for edge in self.network.allowed_outgoing(
                    agent.edge, agent.mode, agent.way_history
                )
            }
            if candidate.id in allowed_ids:
                agent.planned_edge_id = candidate.id
                lane_options = self._turn_lane_options(
                    agent.edge, candidate
                )
                agent.lane_index = self._nearest_lane(
                    agent.lane_index, lane_options
                )
                return
            self._clear_route(agent)

        candidates = self.network.allowed_outgoing(
            agent.edge, agent.mode, agent.way_history
        )
        if not candidates:
            agent.planned_edge_id = None
            return
        continuing = [candidate for candidate in candidates if candidate.way_id == agent.edge.way_id]
        candidate = (
            self.random.choice(continuing)
            if continuing and self.random.random() < 0.68
            else self.random.choice(candidates)
        )
        agent.planned_edge_id = candidate.id
        lane_options = self._turn_lane_options(agent.edge, candidate)
        agent.lane_index = self._nearest_lane(agent.lane_index, lane_options)

    def _turn_lane_options(
        self, edge: NetworkEdge, outgoing: NetworkEdge
    ) -> tuple[int, ...]:
        cache_key = (edge.id, outgoing.id)
        cached_options = self._turn_lane_options_cache.get(cache_key)
        if cached_options is None:
            cached_options = self.network.lane_options_for_turn(edge, outgoing)
            self._turn_lane_options_cache[cache_key] = cached_options
        return cached_options

    @staticmethod
    def _clear_route(agent: NetworkAgent) -> None:
        agent.route_edge_ids = ()
        agent.route_index = 0
        agent.origin_poi = None
        agent.destination_poi = None
        agent.origin_snap_distance_meters = 0.0
        agent.destination_snap_distance_meters = 0.0
        agent.origin_poi_kind = "poi"
        agent.destination_poi_kind = "poi"

    @staticmethod
    def _move_occupancy(
        occupancy: dict[tuple[str, str], int] | None,
        mode: str,
        old_edge_id: str,
        new_edge_id: str,
    ) -> None:
        if occupancy is None or old_edge_id == new_edge_id:
            return
        old_key = (mode, old_edge_id)
        old_count = occupancy.get(old_key, 0)
        if old_count <= 1:
            occupancy.pop(old_key, None)
        else:
            occupancy[old_key] = old_count - 1
        new_key = (mode, new_edge_id)
        occupancy[new_key] = occupancy.get(new_key, 0) + 1

    @staticmethod
    def _edge_vehicle_capacity(edge: NetworkEdge) -> int:
        """Return the number of cars that can physically queue on an edge."""

        return max(
            edge.lanes,
            int(edge.lanes * edge.length_meters / CAR_LENGTH_METERS),
        )

    def _lane_options_after_entry(
        self, agent: NetworkAgent, next_edge: NetworkEdge
    ) -> tuple[int, ...]:
        route_index = agent.route_index + 1
        if (
            agent.route_edge_ids
            and 0 <= route_index < len(agent.route_edge_ids)
            and agent.route_edge_ids[route_index] == next_edge.id
            and route_index + 1 < len(agent.route_edge_ids)
        ):
            following_edge = self.network.edges_by_id[
                agent.route_edge_ids[route_index + 1]
            ]
            return self._turn_lane_options(
                next_edge, following_edge
            )
        return tuple(range(next_edge.lanes))

    def _mapped_lane_for_transition(
        self,
        source_edge: NetworkEdge,
        source_lane: int,
        target_edge: NetworkEdge,
        target_lane_options: tuple[int, ...],
    ) -> int:
        """Map compatible source lanes onto compatible target lanes by rank.

        Lane indices are local to an OSM edge.  Clamping a three-lane source
        index to a two-lane target collapsed both source lanes 1 and 2 onto
        target lane 1.  That is particularly visible where Bocskai ut feeds
        the two-lane Nagyszolos utca.  Relative rank preserves both parallel
        traffic streams without introducing congestion-triggered weaving.
        """

        target_options = tuple(
            lane_index
            for lane_index in target_lane_options
            if 0 <= lane_index < target_edge.lanes
        ) or tuple(range(target_edge.lanes))
        cache_key = (
            source_edge.id,
            source_lane,
            target_edge.id,
            target_options,
        )
        cached_lane = self._lane_transition_cache.get(cache_key)
        if cached_lane is not None:
            return cached_lane

        source_options = tuple(
            lane_index
            for lane_index in self._turn_lane_options(
                source_edge, target_edge
            )
            if 0 <= lane_index < source_edge.lanes
        ) or tuple(range(source_edge.lanes))
        compatible_source_lane = self._nearest_lane(
            min(max(0, source_lane), source_edge.lanes - 1),
            source_options,
        )
        if len(target_options) == 1:
            mapped_lane = target_options[0]
            self._lane_transition_cache[cache_key] = mapped_lane
            return mapped_lane
        if len(source_options) > 1:
            if (
                len(source_options) != len(target_options)
                and compatible_source_lane in target_options
            ):
                # A widening road does not require a lateral move.  Rank
                # remapping is needed when equal compatible streams shift
                # indices (the Bocskai 1,2 -> Nagyszolos 0,1 case), while a
                # still-valid lane on a wider target should remain stable.
                mapped_lane = compatible_source_lane
                self._lane_transition_cache[cache_key] = mapped_lane
                return mapped_lane
            source_rank = source_options.index(compatible_source_lane)
            target_rank = floor(
                source_rank * (len(target_options) - 1)
                / (len(source_options) - 1)
                + 0.5
            )
            mapped_lane = target_options[target_rank]
            self._lane_transition_cache[cache_key] = mapped_lane
            return mapped_lane

        turn_kind = _turn_kind(source_edge.bearing, target_edge.bearing)
        if turn_kind == "left":
            mapped_lane = target_options[0]
        elif turn_kind == "right":
            mapped_lane = target_options[-1]
        else:
            source_fraction = (
                compatible_source_lane / (source_edge.lanes - 1)
                if source_edge.lanes > 1
                else 0.5
            )
            mapped_lane = min(
                target_options,
                key=lambda lane_index: (
                    abs(
                        lane_index / max(1, target_edge.lanes - 1)
                        - source_fraction
                    ),
                    lane_index,
                ),
            )
        self._lane_transition_cache[cache_key] = mapped_lane
        return mapped_lane

    def _build_merge_candidate_edge_ids(self) -> frozenset[str]:
        """Return edges where distinct upstream lanes can actually converge."""

        incoming_by_node: dict[int, list[NetworkEdge]] = {}
        for edge in self.network.edges_by_mode["car"]:
            incoming_by_node.setdefault(edge.to_node, []).append(edge)

        candidate_ids: set[str] = set()
        for target_edge in self.network.edges_by_mode["car"]:
            incoming_edges = tuple(
                incoming_edge
                for incoming_edge in incoming_by_node.get(
                    target_edge.from_node, ()
                )
                if not (
                    target_edge.to_node == incoming_edge.from_node
                    and target_edge.segment_id == incoming_edge.segment_id
                )
            )
            if len(incoming_edges) > 1 or any(
                incoming_edge.lanes > target_edge.lanes
                for incoming_edge in incoming_edges
            ):
                candidate_ids.add(target_edge.id)
                continue

            # A turn-lane restriction on this edge can also collapse several
            # current lanes onto one lane before its following turn. Keep such
            # edges in the conservative merge set even with one predecessor.
            if target_edge.turn_lanes and any(
                len(self._turn_lane_options(target_edge, outgoing_edge))
                < target_edge.lanes
                for outgoing_edge in self.network.outgoing.get(
                    (target_edge.to_node, "car"), ()
                )
            ):
                candidate_ids.add(target_edge.id)
        return frozenset(candidate_ids)

    def _bounded_route_edges(
        self,
        route_edge_ids: tuple[str, ...],
        start_index: int,
        distance_limit: float = CAR_LENGTH_METERS,
    ) -> tuple[NetworkEdge, ...]:
        """Materialize only the headway-sized prefix plus one turn look-ahead."""

        route_edges: list[NetworkEdge] = []
        covered_distance = 0.0
        look_ahead_pending = False
        route_cursor = start_index
        while route_cursor < len(route_edge_ids):
            edge_id = route_edge_ids[route_cursor]
            route_cursor += 1
            route_edge = self.network.edges_by_id[edge_id]
            route_edges.append(route_edge)
            if look_ahead_pending:
                break
            covered_distance += route_edge.length_meters
            if covered_distance >= distance_limit:
                look_ahead_pending = True
        return tuple(route_edges)

    def _route_suffix_from_next(
        self,
        agent: NetworkAgent,
        next_edge: NetworkEdge,
        distance_limit: float = CAR_LENGTH_METERS,
    ) -> tuple[NetworkEdge, ...]:
        next_route_index = agent.route_index + 1
        if (
            agent.route_edge_ids
            and 0 <= next_route_index < len(agent.route_edge_ids)
            and agent.route_edge_ids[next_route_index] == next_edge.id
        ):
            # Headway only needs a car-length of geometry plus one look-ahead
            # edge for the final lane mapping.  Materialising every remaining
            # edge of every A-B route at 30 Hz caused avoidable allocation and
            # CPU spikes on long routes.
            return self._bounded_route_edges(
                agent.route_edge_ids, next_route_index, distance_limit
            )

        # Route-less traffic still needs safe spacing on chains of OSM micro
        # edges. Follow only an unambiguous continuation; at a branch the
        # eventual random choice is not known yet, so admission is handled
        # again after the next edge has been planned.
        route_edges = [next_edge]
        covered_distance = next_edge.length_meters
        look_ahead_pending = covered_distance >= distance_limit
        way_history = self.network.extend_way_history(
            agent.way_history, next_edge.way_id
        )
        seen_edge_ids = {agent.edge.id, next_edge.id}
        while True:
            outgoing = self.network.allowed_outgoing(
                route_edges[-1], agent.mode, way_history
            )
            candidates = tuple(
                edge for edge in outgoing if edge.id not in seen_edge_ids
            )
            if len(candidates) != 1:
                break
            route_edge = candidates[0]
            route_edges.append(route_edge)
            if look_ahead_pending:
                break
            covered_distance += route_edge.length_meters
            if covered_distance >= distance_limit:
                look_ahead_pending = True
            seen_edge_ids.add(route_edge.id)
            way_history = self.network.extend_way_history(
                way_history, route_edge.way_id
            )
        return tuple(route_edges)

    def _mapped_route_lanes(
        self,
        agent: NetworkAgent,
        route_edges: tuple[NetworkEdge, ...],
        first_lane: int,
    ) -> tuple[int, ...]:
        if not route_edges:
            return ()
        lanes = [first_lane]
        for edge_index, edge in enumerate(route_edges[:-1]):
            next_edge = route_edges[edge_index + 1]
            following_edge = (
                route_edges[edge_index + 2]
                if edge_index + 2 < len(route_edges)
                else None
            )
            target_options = (
                self._turn_lane_options(next_edge, following_edge)
                if following_edge is not None
                else tuple(range(next_edge.lanes))
            )
            lanes.append(
                self._mapped_lane_for_transition(
                    edge,
                    lanes[-1],
                    next_edge,
                    target_options,
                )
            )
        return tuple(lanes)

    def _downstream_rear_distance(
        self,
        agent: NetworkAgent,
        next_edge: NetworkEdge,
        next_lane: int,
        lane_positions: dict[tuple[str, int], dict[int, float]],
    ) -> float | None:
        """Return the nearest routed leader measured from next edge's start."""

        cached_path = agent.car_headway_path_cache
        if (
            cached_path is not None
            and cached_path[0] == agent.edge.id
            and cached_path[1] == agent.route_index
            and cached_path[2] is agent.route_edge_ids
            and cached_path[3] == agent.planned_edge_id
            and cached_path[4] == agent.way_history
            and cached_path[5] == next_edge.id
            and cached_path[6] == next_lane
        ):
            route_path = cached_path[7]
        else:
            route_edges = self._route_suffix_from_next(agent, next_edge)
            route_lanes = self._mapped_route_lanes(
                agent, route_edges, next_lane
            )
            route_path = tuple(zip(route_edges, route_lanes))
            agent.car_headway_path_cache = (
                agent.edge.id,
                agent.route_index,
                agent.route_edge_ids,
                agent.planned_edge_id,
                agent.way_history,
                next_edge.id,
                next_lane,
                route_path,
            )
        return self._rear_distance_on_path(
            agent.id, route_path, lane_positions
        )

    def _rear_distance_on_path(
        self,
        agent_id: int,
        route_path: tuple[tuple[NetworkEdge, int], ...],
        lane_positions: dict[tuple[str, int], dict[int, float]],
    ) -> float | None:
        distance_before_edge = 0.0
        for edge, lane_index in route_path:
            positions = lane_positions.get((edge.id, lane_index), {})
            rear_distance: float | None = None
            for positioned_agent_id, distance in positions.items():
                if positioned_agent_id == agent_id:
                    continue
                if rear_distance is None or distance < rear_distance:
                    rear_distance = distance
            if rear_distance is not None:
                if self.network.nodes[edge.to_node].traffic_signal:
                    rear_distance = min(
                        rear_distance,
                        max(0.0, edge.length_meters - 0.25),
                    )
                return distance_before_edge + rear_distance
            distance_before_edge += edge.length_meters
        return None

    def _initial_headway_reservations(
        self, agent: NetworkAgent
    ) -> tuple[tuple[str, int, float], ...]:
        """Reserve the short downstream route occupied by a car's headway."""

        next_edge = self.network.edges_by_id.get(agent.planned_edge_id or "")
        remaining_headway = (
            CAR_LENGTH_METERS
            - (agent.edge.length_meters - agent.distance_meters)
        )
        if next_edge is None or remaining_headway <= 1e-9:
            return ()
        target_options = self._lane_options_after_entry(agent, next_edge)
        first_lane = self._mapped_lane_for_transition(
            agent.edge,
            agent.lane_index,
            next_edge,
            target_options,
        )
        route_edges = self._route_suffix_from_next(agent, next_edge)
        route_lanes = self._mapped_route_lanes(agent, route_edges, first_lane)
        reservations: list[tuple[str, int, float]] = []
        for edge, lane_index in zip(route_edges, route_lanes):
            reservations.append(
                (edge.id, lane_index, min(edge.length_meters, remaining_headway))
            )
            remaining_headway -= edge.length_meters
            if remaining_headway <= 1e-9:
                break
        return tuple(reservations)

    def _merge_approach_slots(
        self,
        agent: NetworkAgent,
        lookahead_distance: float,
        *,
        merge_candidates_only: bool = True,
    ) -> tuple[tuple[tuple[str, int], float, float], ...]:
        """Return virtual lane coordinates along a short merge approach."""

        if agent.mode != "car":
            return ()
        remaining_distance = agent.edge.length_meters - agent.distance_meters
        if remaining_distance >= lookahead_distance:
            return ()
        cached_path = agent.car_merge_path_cache
        if (
            cached_path is not None
            and cached_path[0] == agent.edge.id
            and cached_path[1] == agent.route_index
            and cached_path[2] is agent.route_edge_ids
            and cached_path[3] == agent.planned_edge_id
            and cached_path[4] == agent.way_history
            and cached_path[7] >= lookahead_distance
            and cached_path[9] == agent.lane_index
        ):
            route_path = cached_path[8]
        else:
            next_edge = self.network.edges_by_id.get(
                agent.planned_edge_id or ""
            )
            if next_edge is None:
                return ()
            lane_options = self._lane_options_after_entry(agent, next_edge)
            next_lane = self._mapped_lane_for_transition(
                agent.edge,
                agent.lane_index,
                next_edge,
                lane_options,
            )
            route_edges = self._route_suffix_from_next(
                agent, next_edge, lookahead_distance
            )
            route_lanes = self._mapped_route_lanes(
                agent, route_edges, next_lane
            )
            route_path = tuple(zip(route_edges, route_lanes))
            agent.car_merge_path_cache = (
                agent.edge.id,
                agent.route_index,
                agent.route_edge_ids,
                agent.planned_edge_id,
                agent.way_history,
                next_edge.id,
                next_lane,
                lookahead_distance,
                route_path,
                agent.lane_index,
            )
        slots: list[tuple[tuple[str, int], float, float]] = []
        distance_to_edge = remaining_distance
        for route_edge, route_lane in route_path:
            if distance_to_edge >= lookahead_distance:
                break
            if (
                not merge_candidates_only
                or route_edge.id in self._merge_candidate_edge_ids
            ):
                slots.append(
                    (
                        (route_edge.id, route_lane),
                        -distance_to_edge,
                        distance_to_edge,
                    )
                )
            distance_to_edge += route_edge.length_meters
        return tuple(slots)

    def _entry_lane(
        self,
        agent: NetworkAgent,
        next_edge: NetworkEdge,
        lane_positions: dict[tuple[str, int], dict[int, float]] | None,
    ) -> tuple[int, float | None] | None:
        lane_options = self._lane_options_after_entry(agent, next_edge)
        preferred_lane = self._mapped_lane_for_transition(
            agent.edge,
            agent.lane_index,
            next_edge,
            lane_options,
        )
        # A momentarily occupied lane entrance is a queue, not a reason to
        # weave.  The stable rank mapping above can still use every lane when
        # lane counts change, but 2 -> 2 congestion never causes oscillation.
        ordered_lanes = (preferred_lane,)
        if lane_positions is None or agent.mode != "car":
            return ordered_lanes[0], None
        for lane_index in ordered_lanes:
            rear_distance = self._downstream_rear_distance(
                agent,
                next_edge,
                lane_index,
                lane_positions,
            )
            if (
                rear_distance is None
                or rear_distance >= CAR_LENGTH_METERS
            ):
                return lane_index, rear_distance
        return None

    @staticmethod
    def _localized_merge_limit(
        agent: NetworkAgent, allowed_travel_meters: float
    ) -> tuple[str, int, float]:
        """Map a route-distance merge budget onto its concrete future edge."""

        allowed_travel = max(0.0, allowed_travel_meters)
        distance_to_edge_end = (
            agent.edge.length_meters - agent.distance_meters
        )
        if allowed_travel < distance_to_edge_end - 1e-9:
            return (
                agent.edge.id,
                agent.lane_index,
                agent.distance_meters + allowed_travel,
            )
        remaining_travel = max(0.0, allowed_travel - distance_to_edge_end)
        cached_path = agent.car_merge_path_cache
        route_path = cached_path[8] if cached_path is not None else ()
        for route_edge, route_lane in route_path:
            if remaining_travel < route_edge.length_meters - 1e-9:
                return route_edge.id, route_lane, remaining_travel
            remaining_travel = max(
                0.0, remaining_travel - route_edge.length_meters
            )
        return agent.edge.id, agent.lane_index, agent.edge.length_meters

    def _car_following_context(
        self, delta_seconds: float = 0.0,
    ) -> tuple[
        dict[int, tuple[str, int, float]],
        dict[tuple[str, int], dict[int, float]],
    ]:
        lane_groups: dict[tuple[str, int], list[NetworkAgent]] = {}
        car_agents: list[NetworkAgent] = []
        for agent in self.agents:
            if agent.mode != "car":
                continue
            car_agents.append(agent)
            agent.lane_index = min(
                max(0, agent.lane_index), agent.edge.lanes - 1
            )
            lane_groups.setdefault(
                (agent.edge.id, agent.lane_index), []
            ).append(agent)

        following_limits: dict[int, tuple[str, int, float]] = {}
        lane_positions: dict[tuple[str, int], dict[int, float]] = {}
        for lane_key, cars in lane_groups.items():
            cars.sort(key=lambda car: car.distance_meters, reverse=True)
            lane_positions[lane_key] = {
                car.id: car.distance_meters for car in cars
            }
            for leader, follower in zip(cars, cars[1:]):
                leader_reference = leader.distance_meters
                if self.network.nodes[leader.edge.to_node].traffic_signal:
                    leader_reference = min(
                        leader_reference,
                        max(0.0, leader.edge.length_meters - 0.25),
                    )
                following_limits[follower.id] = (
                    lane_key[0],
                    lane_key[1],
                    max(0.0, leader_reference - CAR_LENGTH_METERS),
                )

        # Front cars from several source lanes/edges may converge into the
        # same target lane. Treat their remaining approach distance as a
        # virtual negative target-lane coordinate. This reserves merge order
        # before agent iteration, so list/id order cannot let two contenders
        # enter an initially empty lane in the same tick.
        merge_groups: dict[
            tuple[str, int],
            list[tuple[float, int, NetworkAgent, float]],
        ] = {}
        active_approaches: dict[tuple[str, int], int] = {}
        near_front_agents: list[NetworkAgent] = []
        delta = max(0.0, delta_seconds)
        for agent in car_agents:
            if agent.id in following_limits:
                continue
            lookahead_distance = (
                CAR_LENGTH_METERS
                + agent.desired_speed_mps * delta
            )
            if (
                agent.edge.length_meters - agent.distance_meters
                >= lookahead_distance
            ):
                continue
            near_front_agents.append(agent)
            for merge_key, merge_coordinate, distance_to_merge in (
                self._merge_approach_slots(
                    agent,
                    lookahead_distance,
                    merge_candidates_only=False,
                )
            ):
                reserved_agent_id = active_approaches.get(merge_key)
                if reserved_agent_id is None:
                    active_approaches[merge_key] = agent.id
                elif reserved_agent_id != agent.id:
                    # Agent identifiers are positive; -1 compactly marks a
                    # slot reserved by more than one approach.
                    active_approaches[merge_key] = -1
                if merge_key[0] in self._merge_candidate_edge_ids:
                    merge_groups.setdefault(merge_key, []).append(
                        (
                            merge_coordinate,
                            agent.id,
                            agent,
                            distance_to_merge,
                        )
                    )
        self._active_merge_approaches = active_approaches
        merge_travel_limits: dict[int, float] = {}
        for contenders in merge_groups.values():
            if len(contenders) < 2:
                continue
            contenders.sort(reverse=True, key=lambda item: (item[0], -item[1]))
            for (leader_coordinate, _, _, _), (
                _,
                _,
                follower,
                follower_distance_to_merge,
            ) in zip(
                contenders, contenders[1:]
            ):
                allowed_travel = max(
                    0.0,
                    follower_distance_to_merge
                    + leader_coordinate
                    - CAR_LENGTH_METERS,
                )
                previous_travel_limit = merge_travel_limits.get(follower.id)
                if (
                    previous_travel_limit is None
                    or allowed_travel < previous_travel_limit
                ):
                    merge_travel_limits[follower.id] = allowed_travel
                    following_limits[follower.id] = (
                        self._localized_merge_limit(
                            follower, allowed_travel
                        )
                    )
        for agent in near_front_agents:
            existing_limit = following_limits.get(agent.id)
            if (
                existing_limit is not None
                and existing_limit[0] == agent.edge.id
                and existing_limit[1] == agent.lane_index
            ):
                continue
            next_edge = self.network.edges_by_id.get(
                agent.planned_edge_id or ""
            )
            if next_edge is None:
                continue
            target_options = self._lane_options_after_entry(agent, next_edge)
            next_lane = self._mapped_lane_for_transition(
                agent.edge,
                agent.lane_index,
                next_edge,
                target_options,
            )
            rear_distance = self._downstream_rear_distance(
                agent,
                next_edge,
                next_lane,
                lane_positions,
            )
            if rear_distance is None or rear_distance >= CAR_LENGTH_METERS:
                continue
            following_limits[agent.id] = (
                agent.edge.id,
                agent.lane_index,
                max(
                    0.0,
                    agent.edge.length_meters
                    + rear_distance
                    - CAR_LENGTH_METERS,
                ),
            )
        return following_limits, lane_positions

    @staticmethod
    def _remove_lane_position(
        lane_positions: dict[tuple[str, int], dict[int, float]] | None,
        edge_id: str,
        lane_index: int,
        agent_id: int,
    ) -> None:
        if lane_positions is None:
            return
        lane_key = (edge_id, lane_index)
        positions = lane_positions.get(lane_key)
        if positions is None:
            return
        positions.pop(agent_id, None)
        if not positions:
            lane_positions.pop(lane_key, None)

    @staticmethod
    def _set_lane_position(
        lane_positions: dict[tuple[str, int], dict[int, float]] | None,
        agent: NetworkAgent,
    ) -> None:
        if lane_positions is None or agent.mode != "car":
            return
        lane_positions.setdefault(
            (agent.edge.id, agent.lane_index), {}
        )[agent.id] = agent.distance_meters

    def _upstream_entry_is_clear(
        self,
        agent: NetworkAgent,
        target_edge: NetworkEdge,
        target_lane: int,
    ) -> bool:
        """Protect a relocation/new POI route from active merge approaches."""

        if self._active_merge_approaches is not None:
            reserved_agent_id = self._active_merge_approaches.get(
                (target_edge.id, target_lane)
            )
            return (
                reserved_agent_id is None
                or reserved_agent_id == agent.id
            )

        for other in self.agents:
            if other.id == agent.id or other.mode != "car":
                continue
            remaining_distance = (
                other.edge.length_meters - other.distance_meters
            )
            if remaining_distance >= CAR_LENGTH_METERS:
                continue
            other_next_edge = self.network.edges_by_id.get(
                other.planned_edge_id or ""
            )
            if other_next_edge is None:
                continue
            other_options = self._lane_options_after_entry(
                other, other_next_edge
            )
            other_lane = self._mapped_lane_for_transition(
                other.edge,
                other.lane_index,
                other_next_edge,
                other_options,
            )
            route_edges = self._route_suffix_from_next(
                other, other_next_edge
            )
            route_lanes = self._mapped_route_lanes(
                other, route_edges, other_lane
            )
            distance_to_edge = remaining_distance
            for route_edge, route_lane in zip(route_edges, route_lanes):
                if distance_to_edge >= CAR_LENGTH_METERS:
                    break
                if (
                    route_edge.id == target_edge.id
                    and route_lane == target_lane
                ):
                    return False
                distance_to_edge += route_edge.length_meters
        return True

    def _restart_agent_trip(
        self,
        agent: NetworkAgent,
        *,
        prefer_gateway: bool,
        occupancy: dict[tuple[str, str], int] | None = None,
        lane_positions: dict[tuple[str, int], dict[int, float]] | None = None,
        following_limits: dict[int, tuple[str, int, float]] | None = None,
    ) -> bool:
        selected_route = None
        first_edge = None
        lane_index = 0
        rear_distance: float | None = None
        attempts = 32 if agent.mode == "car" and occupancy is not None else 1
        for _ in range(attempts):
            route = self._initial_poi_route(
                agent.mode, prefer_gateway=prefer_gateway
            )
            if route is None:
                return False
            _, _, route_edge_ids = route
            candidate_edge = self.network.edges_by_id[route_edge_ids[0]]
            if (
                agent.mode == "car"
                and occupancy is not None
                and occupancy.get((agent.mode, candidate_edge.id), 0)
                >= self._edge_vehicle_capacity(candidate_edge)
            ):
                continue
            lane_options = tuple(range(candidate_edge.lanes))
            if len(route_edge_ids) > 1:
                lane_options = self._turn_lane_options(
                    candidate_edge,
                    self.network.edges_by_id[route_edge_ids[1]],
                )
            clear_lanes = lane_options
            rear_distance_by_lane: dict[int, float | None] = {}
            if agent.mode == "car" and lane_positions is not None:
                clear_lane_values = []
                route_edges = self._bounded_route_edges(route_edge_ids, 0)
                for candidate_lane in lane_options:
                    route_lanes = self._mapped_route_lanes(
                        agent, route_edges, candidate_lane
                    )
                    candidate_rear = self._rear_distance_on_path(
                        agent.id,
                        tuple(zip(route_edges, route_lanes)),
                        lane_positions,
                    )
                    rear_distance_by_lane[candidate_lane] = candidate_rear
                    if (
                        (
                            candidate_rear is None
                            or candidate_rear >= CAR_LENGTH_METERS
                        )
                        and self._upstream_entry_is_clear(
                            agent, candidate_edge, candidate_lane
                        )
                    ):
                        clear_lane_values.append(candidate_lane)
                clear_lanes = tuple(clear_lane_values)
                if not clear_lanes:
                    continue
            selected_route = route
            first_edge = candidate_edge
            lane_index = self.random.choice(clear_lanes)
            rear_distance = rear_distance_by_lane.get(lane_index)
            break
        if selected_route is None or first_edge is None:
            return False
        origin, destination, route_edge_ids = selected_route
        old_edge_id = agent.edge.id
        old_lane_index = agent.lane_index
        desired_speed_mps = self._desired_speed_for_agent(agent, first_edge)
        agent.edge = first_edge
        agent.distance_meters = 0.0
        agent.desired_speed_mps = desired_speed_mps
        agent.current_speed_mps = 0.0
        agent.lane_index = lane_index
        agent.planned_edge_id = None
        agent.wait_seconds = 0.0
        agent.signal_checked = False
        agent.trip_distance_meters = 0.0
        agent.trip_target_meters = self._trip_target(agent.mode)
        agent.way_history = (first_edge.way_id,)
        agent.route_edge_ids = route_edge_ids
        agent.route_index = 0
        agent.origin_poi = origin.poi
        agent.destination_poi = destination.poi
        agent.origin_snap_distance_meters = origin.snap_distance_meters
        agent.destination_snap_distance_meters = destination.snap_distance_meters
        agent.origin_poi_kind = "gateway" if origin.gateway else "poi"
        agent.destination_poi_kind = (
            "gateway" if destination.gateway else "poi"
        )
        agent.relocation_generation += 1
        self._move_occupancy(
            occupancy, agent.mode, old_edge_id, first_edge.id
        )
        if agent.mode == "car":
            self._remove_lane_position(
                lane_positions,
                old_edge_id,
                old_lane_index,
                agent.id,
            )
        if following_limits is not None:
            following_limits.pop(agent.id, None)
            if rear_distance is not None:
                following_limits[agent.id] = (
                    first_edge.id,
                    lane_index,
                    max(0.0, rear_distance - CAR_LENGTH_METERS),
                )
        self._set_lane_position(lane_positions, agent)
        self.route_reseeds += 1
        if origin.gateway:
            self.gateway_entries += 1
        self._plan_next(agent)
        return True

    def _enter_next_edge(
        self,
        agent: NetworkAgent,
        occupancy: dict[tuple[str, str], int] | None = None,
        lane_positions: dict[tuple[str, int], dict[int, float]] | None = None,
        following_limits: dict[int, tuple[str, int, float]] | None = None,
    ) -> bool:
        next_edge = self.network.edges_by_id.get(agent.planned_edge_id or "")
        allowed_ids = {
            edge.id
            for edge in self.network.allowed_outgoing(
                agent.edge, agent.mode, agent.way_history
            )
        }
        if (
            next_edge is None
            or next_edge.id not in allowed_ids
            or next_edge.from_node != agent.edge.to_node
            or agent.mode not in next_edge.modes
        ):
            agent.planned_edge_id = None
            return False

        if (
            occupancy is not None
            and agent.mode == "car"
            and occupancy.get((agent.mode, next_edge.id), 0)
            >= self._edge_vehicle_capacity(next_edge)
        ):
            # Keep the planned edge: this is a temporary capacity wait, not a
            # broken route. The next simulation step will retry admission.
            return False

        entry_lane = self._entry_lane(agent, next_edge, lane_positions)
        if entry_lane is None:
            # The edge still has aggregate storage, but every compatible lane
            # is occupied too close to its start for a safe merge.
            return False
        target_lane, rear_distance = entry_lane
        if (
            agent.route_index < 0
            and not self._upstream_entry_is_clear(
                agent, next_edge, target_lane
            )
        ):
            return False
        reserved_following_limit = (
            following_limits.get(agent.id)
            if following_limits is not None
            else None
        )
        if (
            reserved_following_limit is not None
            and reserved_following_limit[0] == next_edge.id
        ):
            reserved_lane = min(
                max(0, reserved_following_limit[1]),
                next_edge.lanes - 1,
            )
            if reserved_lane != target_lane and lane_positions is not None:
                reserved_rear = self._downstream_rear_distance(
                    agent, next_edge, reserved_lane, lane_positions
                )
                if (
                    reserved_rear is not None
                    and reserved_rear < CAR_LENGTH_METERS
                ):
                    return False
                rear_distance = reserved_rear
            target_lane = reserved_lane

        if (
            agent.route_edge_ids
            and agent.route_index + 1 < len(agent.route_edge_ids)
            and agent.route_edge_ids[agent.route_index + 1] == next_edge.id
        ):
            agent.route_index += 1
        elif agent.route_edge_ids:
            self._clear_route(agent)
        old_edge_id = agent.edge.id
        old_lane_index = agent.lane_index
        old_edge_length = agent.edge.length_meters
        desired_speed_mps = self._desired_speed_for_agent(agent, next_edge)
        agent.edge = next_edge
        agent.way_history = self.network.extend_way_history(
            agent.way_history, next_edge.way_id
        )
        agent.distance_meters = 0.0
        agent.desired_speed_mps = desired_speed_mps
        agent.signal_checked = False
        agent.lane_index = target_lane
        self._move_occupancy(
            occupancy, agent.mode, old_edge_id, next_edge.id
        )
        if agent.mode == "car" and lane_positions is not None:
            # Keep a departure ghost for the remainder of this tick. It
            # closes the race where the same car clears a micro edge before a
            # later contender from another approach checks that target lane.
            lane_positions.setdefault(
                (old_edge_id, old_lane_index), {}
            )[agent.id] = old_edge_length
        self._plan_next(agent)
        if (
            reserved_following_limit is not None
            and reserved_following_limit[0] == next_edge.id
        ):
            # The merge reservation was localized onto this future edge.
            # Preserve its mapped lane across the immediate post-entry plan.
            agent.lane_index = min(
                max(0, reserved_following_limit[1]),
                next_edge.lanes - 1,
            )
        if agent.mode == "car" and agent.lane_index != target_lane:
            planned_positions = (
                lane_positions.get((next_edge.id, agent.lane_index), {})
                if lane_positions is not None
                else {}
            )
            planned_rear = min(planned_positions.values(), default=None)
            if (
                planned_rear is not None
                and self.network.nodes[next_edge.to_node].traffic_signal
            ):
                planned_rear = min(
                    planned_rear,
                    max(0.0, next_edge.length_meters - 0.25),
                )
            if (
                planned_rear is not None
                and planned_rear < CAR_LENGTH_METERS
            ):
                agent.lane_index = target_lane
            else:
                rear_distance = planned_rear
        if following_limits is not None:
            following_limits.pop(agent.id, None)
            next_following_limit = (
                reserved_following_limit
                if reserved_following_limit is not None
                and reserved_following_limit[0] != old_edge_id
                else None
            )
            if rear_distance is not None:
                rear_limit = (
                    next_edge.id,
                    agent.lane_index,
                    max(0.0, rear_distance - CAR_LENGTH_METERS),
                )
                if (
                    next_following_limit is None
                    or next_following_limit[0] != next_edge.id
                    or next_following_limit[1] != agent.lane_index
                    or rear_limit[2] < next_following_limit[2]
                ):
                    next_following_limit = rear_limit
            if next_following_limit is not None:
                following_limits[agent.id] = next_following_limit
        self._set_lane_position(lane_positions, agent)
        return True

    def _complete_poi_trip(
        self,
        agent: NetworkAgent,
        occupancy: dict[tuple[str, str], int] | None = None,
        lane_positions: dict[tuple[str, int], dict[int, float]] | None = None,
        following_limits: dict[int, tuple[str, int, float]] | None = None,
    ) -> bool:
        destination = agent.destination_poi
        if destination is None:
            return False
        self.completed_trips += 1
        agent.trip_distance_meters = 0.0
        origin = self.route_pois_by_id[agent.mode].get(destination.id)
        if origin is not None:
            if origin.gateway:
                self.gateway_exits += 1
                if self._restart_agent_trip(
                    agent,
                    prefer_gateway=True,
                    occupancy=occupancy,
                    lane_positions=lane_positions,
                    following_limits=following_limits,
                ):
                    return True
            selected = self._choose_poi_route(
                agent.mode,
                origin,
                incoming_edge=agent.edge,
                way_history=agent.way_history,
            )
            if selected is None:
                # Közbenső POI-nál nem dobjuk el az érkezési irányt: ez volt
                # az elkerülhető visszafordulások fő forrása. Új külső vagy
                # belső indulást mintázunk, ha nincs kompatibilis folytatás.
                if self._restart_agent_trip(
                    agent,
                    prefer_gateway=False,
                    occupancy=occupancy,
                    lane_positions=lane_positions,
                    following_limits=following_limits,
                ):
                    return True
            if selected is not None:
                next_destination, route_edge_ids = selected
                first_edge = self.network.edges_by_id[route_edge_ids[0]]
                agent.origin_poi = origin.poi
                agent.destination_poi = next_destination.poi
                agent.origin_snap_distance_meters = origin.snap_distance_meters
                agent.destination_snap_distance_meters = (
                    next_destination.snap_distance_meters
                )
                agent.origin_poi_kind = "gateway" if origin.gateway else "poi"
                agent.destination_poi_kind = (
                    "gateway" if next_destination.gateway else "poi"
                )
                agent.route_edge_ids = route_edge_ids
                # The newly selected route begins after the current arrival
                # edge. Keeping index -1 lets the normal admission path move
                # onto route_edge_ids[0] without bypassing lane headway.
                agent.route_index = -1
                agent.planned_edge_id = first_edge.id
                agent.wait_seconds = self._poi_dwell_seconds(
                    origin.poi, agent.mode
                )
                entered = self._enter_next_edge(
                    agent,
                    occupancy,
                    lane_positions,
                    following_limits,
                )
                if entered:
                    return True
                # The route becomes known only at the POI located at this
                # edge end. Rewinding the car by a headway here would be a
                # visible backwards teleport. Pick a safe relocation instead;
                # relocation_generation tells the client not to interpolate.
                return self._restart_agent_trip(
                    agent,
                    prefer_gateway=False,
                    occupancy=occupancy,
                    lane_positions=lane_positions,
                    following_limits=following_limits,
                )

        self._clear_route(agent)
        old_lane_index = agent.lane_index
        self._plan_next(agent)
        # Planning may choose a required turn lane on the edge that the car is
        # already leaving. Keep the physical/source lane unchanged until the
        # normal admission path can atomically move its lane registry entry.
        agent.lane_index = old_lane_index
        return self._enter_next_edge(
            agent, occupancy, lane_positions, following_limits
        )

    def _advance_from_edge_end(
        self,
        agent: NetworkAgent,
        occupancy: dict[tuple[str, str], int] | None = None,
        lane_positions: dict[tuple[str, int], dict[int, float]] | None = None,
        following_limits: dict[int, tuple[str, int, float]] | None = None,
    ) -> bool:
        if (
            agent.route_edge_ids
            and agent.route_index == len(agent.route_edge_ids) - 1
        ):
            return self._complete_poi_trip(
                agent, occupancy, lane_positions, following_limits
            )
        return self._enter_next_edge(
            agent, occupancy, lane_positions, following_limits
        )

    def _car_density_window(
        self,
        agent: NetworkAgent,
        occupancy: dict[tuple[str, str], int],
        density_cache: dict[tuple[str, ...], float],
    ) -> float:
        cached_window = agent.car_density_window_cache
        if (
            cached_window is not None
            and cached_window[0] == agent.edge.id
            and cached_window[1] == agent.route_index
            and cached_window[2] is agent.route_edge_ids
            and cached_window[3] == agent.planned_edge_id
        ):
            edge_ids = cached_window[4]
            covered_distance = cached_window[5]
            lane_meters = cached_window[6]
        else:
            window_edge_ids = [agent.edge.id]
            covered_distance = agent.edge.length_meters
            lane_meters = agent.edge.lanes * agent.edge.length_meters
            if (
                agent.route_edge_ids
                and 0 <= agent.route_index < len(agent.route_edge_ids)
                and agent.route_edge_ids[agent.route_index] == agent.edge.id
            ):
                candidate_ids = agent.route_edge_ids
                candidate_index = agent.route_index + 1
            elif agent.planned_edge_id:
                candidate_ids = (agent.planned_edge_id,)
                candidate_index = 0
            else:
                candidate_ids = ()
                candidate_index = 0
            while candidate_index < len(candidate_ids):
                if covered_distance >= MIN_CAR_DENSITY_WINDOW_METERS:
                    break
                edge_id = candidate_ids[candidate_index]
                candidate_index += 1
                if edge_id in window_edge_ids:
                    break
                route_edge = self.network.edges_by_id.get(edge_id)
                if route_edge is None:
                    break
                window_edge_ids.append(edge_id)
                covered_distance += route_edge.length_meters
                lane_meters += route_edge.lanes * route_edge.length_meters
            edge_ids = tuple(window_edge_ids)
            agent.car_density_window_cache = (
                agent.edge.id,
                agent.route_index,
                agent.route_edge_ids,
                agent.planned_edge_id,
                edge_ids,
                covered_distance,
                lane_meters,
            )

        cached_density = density_cache.get(edge_ids)
        if cached_density is not None:
            return cached_density
        car_count = sum(
            occupancy.get(("car", edge_id), 0) for edge_id in edge_ids
        )
        if covered_distance < MIN_CAR_DENSITY_WINDOW_METERS:
            lane_meters += (
                MIN_CAR_DENSITY_WINDOW_METERS - covered_distance
            ) * self.network.edges_by_id[edge_ids[-1]].lanes
        density = car_count / max(1.0, lane_meters / CAR_LENGTH_METERS)
        density_cache[edge_ids] = density
        return density

    def _effective_speed(
        self,
        agent: NetworkAgent,
        occupancy: dict[tuple[str, str], int],
        density_cache: dict[tuple[str, ...], float] | None = None,
    ) -> float:
        if agent.mode == "car":
            density = self._car_density_window(
                agent,
                occupancy,
                density_cache if density_cache is not None else {},
            )
        else:
            count = occupancy.get((agent.mode, agent.edge.id), 1)
            capacity = max(2.0, agent.edge.length_meters / 1.5)
            density = count / capacity
        slowdown = (
            1 / (1 + 4.2 * max(0.0, density - 0.18) ** 1.6)
            if agent.mode == "car"
            else 1 / (1 + 1.2 * max(0.0, density - 0.5) ** 1.4)
        )
        if agent.mode == "car":
            # Overfull initial/reseed states must still drain instead of
            # asymptotically freezing the whole incoming queue.
            slowdown = max(MIN_CAR_CRAWL_FACTOR, slowdown)
        return agent.desired_speed_mps * slowdown

    def step(self, delta_seconds: float) -> None:
        delta = _clamp(float(delta_seconds), 0.0, 120.0)
        if delta <= 0:
            return
        self.elapsed_seconds += delta
        occupancy: dict[tuple[str, str], int] = {}
        for agent in self.agents:
            key = (agent.mode, agent.edge.id)
            occupancy[key] = occupancy.get(key, 0) + 1
        density_occupancy = dict(occupancy)
        following_limits, lane_positions = self._car_following_context(delta)
        car_density_cache: dict[tuple[str, ...], float] = {}

        for agent in self.agents:
            remaining_seconds = delta
            if agent.wait_seconds > 0:
                waiting = min(agent.wait_seconds, remaining_seconds)
                agent.wait_seconds -= waiting
                remaining_seconds -= waiting
                if remaining_seconds <= 1e-9:
                    agent.current_speed_mps = 0.0
                    continue

            transitions = 0
            while remaining_seconds > 1e-9 and transitions < 256:
                speed = self._effective_speed(
                    agent, density_occupancy, car_density_cache
                )
                if speed <= 1e-9:
                    agent.current_speed_mps = 0.0
                    break
                movement_limit = agent.edge.length_meters
                if agent.mode == "car":
                    following_limit = following_limits.get(agent.id)
                    if (
                        following_limit is not None
                        and following_limit[0] == agent.edge.id
                        and following_limit[1] == agent.lane_index
                    ):
                        movement_limit = min(
                            movement_limit,
                            max(agent.distance_meters, following_limit[2]),
                        )
                distance_to_limit = max(
                    0.0, movement_limit - agent.distance_meters
                )
                seconds_to_limit = distance_to_limit / speed
                if seconds_to_limit > remaining_seconds:
                    travelled = speed * remaining_seconds
                    agent.distance_meters += travelled
                    agent.trip_distance_meters += travelled
                    self._set_lane_position(lane_positions, agent)
                    remaining_seconds = 0.0
                    agent.current_speed_mps = speed
                    break

                if movement_limit < agent.edge.length_meters - 1e-9:
                    agent.distance_meters = movement_limit
                    agent.trip_distance_meters += distance_to_limit
                    self._set_lane_position(lane_positions, agent)
                    agent.current_speed_mps = 0.0
                    remaining_seconds = 0.0
                    break

                distance_to_end = distance_to_limit
                seconds_to_end = seconds_to_limit
                arrival_time = self.elapsed_seconds - remaining_seconds + seconds_to_end
                end_node = self.network.nodes[agent.edge.to_node]
                if end_node.traffic_signal and not agent.signal_checked:
                    cycle = 70.0
                    phase = (arrival_time + end_node.id % 31) % cycle
                    green = phase < (41 if agent.mode == "car" else 29)
                    if not green:
                        stop_distance = max(
                            0.0, agent.edge.length_meters - 0.25
                        )
                        stopped_distance = max(
                            agent.distance_meters, stop_distance
                        )
                        travelled = max(
                            0.0, stopped_distance - agent.distance_meters
                        )
                        agent.distance_meters = stopped_distance
                        agent.trip_distance_meters += travelled
                        self._set_lane_position(lane_positions, agent)
                        agent.wait_seconds = cycle - phase
                        agent.signal_checked = True
                        agent.current_speed_mps = 0.0
                        remaining_seconds = 0.0
                        break

                travelled = distance_to_end
                agent.distance_meters = agent.edge.length_meters
                agent.trip_distance_meters += travelled
                self._set_lane_position(lane_positions, agent)
                remaining_seconds -= seconds_to_end
                transitions += 1
                completed_edge = agent.edge
                if not self._advance_from_edge_end(
                    agent,
                    occupancy,
                    lane_positions,
                    following_limits,
                ):
                    agent.current_speed_mps = 0.0
                    remaining_seconds = 0.0
                    if agent.planned_edge_id is None:
                        # A restriction-pruned or otherwise invalid dead end
                        # cannot recover locally. Reseed it explicitly and let
                        # the compact protocol mark the relocation for clients.
                        self._restart_agent_trip(
                            agent,
                            prefer_gateway=False,
                            occupancy=occupancy,
                            lane_positions=lane_positions,
                            following_limits=following_limits,
                        )
                    break
                if agent.mode == "car":
                    self.segment_passed_cars[completed_edge.segment_id] += 1
                agent.current_speed_mps = speed

            if not agent.route_edge_ids and agent.trip_distance_meters >= agent.trip_target_meters:
                self.completed_trips += 1
                agent.trip_distance_meters = 0.0
                agent.trip_target_meters = self._trip_target(agent.mode)
        self._active_merge_approaches = None
        self._record_segment_metrics(delta)

    def _current_segment_car_metrics(
        self,
    ) -> dict[str, tuple[float, float, float]]:
        metrics: dict[str, list[float]] = {}
        for agent in self.agents:
            if agent.mode != "car":
                continue
            segment_id = agent.edge.segment_id
            values = metrics.setdefault(segment_id, [0.0, 0.0, 0.0])
            speed_mps = max(0.0, agent.current_speed_mps)
            speed_limit_mps = max(1e-9, agent.edge.max_speed_kph / 3.6)
            values[0] += speed_mps
            values[1] += _clamp(speed_mps / speed_limit_mps, 0.0, 1.5)
            values[2] += 1.0
        return {
            segment_id: (values[0], values[1], values[2])
            for segment_id, values in metrics.items()
        }

    def _record_segment_metrics(self, delta_seconds: float) -> None:
        delta = max(0.0, float(delta_seconds))
        samples = self._current_segment_car_metrics()
        bucket = {
            segment_id: (
                speed_sum * delta,
                ratio_sum * delta,
                vehicle_count * delta,
            )
            for segment_id, (speed_sum, ratio_sum, vehicle_count) in samples.items()
        }
        if bucket:
            self._segment_metric_buckets.append((self.elapsed_seconds, bucket))
            for segment_id, values in bucket.items():
                totals = self._segment_metric_totals.setdefault(
                    segment_id, [0.0, 0.0, 0.0]
                )
                for index, value in enumerate(values):
                    totals[index] += value

        cutoff = self.elapsed_seconds - SEGMENT_STAT_WINDOW_SECONDS
        while self._segment_metric_buckets and self._segment_metric_buckets[0][0] <= cutoff:
            _, expired = self._segment_metric_buckets.popleft()
            for segment_id, values in expired.items():
                totals = self._segment_metric_totals.get(segment_id)
                if totals is None:
                    continue
                for index, value in enumerate(values):
                    totals[index] -= value
                if totals[2] <= 1e-9:
                    self._segment_metric_totals.pop(segment_id, None)

    def segment_statistics(
        self,
        *,
        segment_id: str | None = None,
        include_segment_id: str | None = None,
    ) -> dict[str, Any]:
        current = self._current_segment_car_metrics()
        if segment_id is not None:
            segment_ids = {str(segment_id)}
        else:
            segment_ids = set(self._segment_metric_totals) | set(current)
            if include_segment_id is not None:
                segment_ids.add(str(include_segment_id))

        records: dict[str, list[int | float]] = {}
        for current_segment_id in segment_ids:
            totals = self._segment_metric_totals.get(current_segment_id)
            current_values = current.get(current_segment_id, (0.0, 0.0, 0.0))
            vehicle_seconds = max(0.0, totals[2]) if totals is not None else 0.0
            if vehicle_seconds > 1e-9:
                average_speed_mps = totals[0] / vehicle_seconds
                speed_ratio = totals[1] / vehicle_seconds
            elif current_values[2] > 0:
                average_speed_mps = current_values[0] / current_values[2]
                speed_ratio = current_values[1] / current_values[2]
            else:
                average_speed_mps = 0.0
                speed_ratio = 0.0
            has_recent_traffic = vehicle_seconds > 1e-9 or current_values[2] > 0
            load_percent = (
                _clamp((1.0 - speed_ratio) * 100.0, 0.0, 100.0)
                if has_recent_traffic
                else 0.0
            )
            records[current_segment_id] = [
                int(self.segment_passed_cars.get(current_segment_id, 0)),
                int(current_values[2]),
                round(average_speed_mps * 3.6, 2),
                round(_clamp(speed_ratio, 0.0, 1.5), 4),
                round(load_percent, 2),
                round(vehicle_seconds, 2),
            ]
        return {
            "windowSeconds": SEGMENT_STAT_WINDOW_SECONDS,
            "elapsedSeconds": self.elapsed_seconds,
            "segments": records,
        }

    def _agent_position(self, agent: NetworkAgent) -> tuple[float, float]:
        ratio = _clamp(agent.distance_meters / agent.edge.length_meters, 0.0, 1.0)
        latitude = agent.edge.start[0] + (agent.edge.end[0] - agent.edge.start[0]) * ratio
        longitude = agent.edge.start[1] + (agent.edge.end[1] - agent.edge.start[1]) * ratio
        if agent.mode == "car" and agent.edge.lanes > 0:
            # Jobb oldali közlekedés: a haladási irány szerinti sávközép enyhe
            # oldaleltolása megakadályozza az egymásra rajzolódást.
            lane_offset = (agent.lane_index - (agent.edge.lanes - 1) / 2) * LANE_WIDTH_METERS
            heading = radians(agent.edge.bearing)
            east_meters = cos(heading) * lane_offset
            north_meters = -sin(heading) * lane_offset
            latitude += north_meters / 111_320
            longitude += east_meters / (111_320 * max(0.2, cos(radians(latitude))))
        return latitude, longitude

    @staticmethod
    def _compact_poi_summary(
        poi: NetworkPOI | None, snap_distance_meters: float, kind: str
    ) -> tuple[Any, ...] | None:
        if poi is None:
            return None
        return (
            poi.id,
            poi.name,
            poi.category,
            kind,
            int(round(snap_distance_meters * 10)),
        )

    def compact_agent_records(
        self,
    ) -> dict[int, tuple[int, int, int, int, int, int]]:
        """Return keyless, quantized agent state for the HTTP delta protocol."""

        records = {}
        for agent in self.agents:
            latitude, longitude = self._agent_position(agent)
            records[agent.id] = (
                0 if agent.mode == "car" else 1,
                int(round(latitude * 10_000_000)),
                int(round(longitude * 10_000_000)),
                int(round(agent.edge.bearing * 10)),
                int(agent.wait_seconds > 0),
                agent.relocation_generation,
            )
        return records

    def compact_selected_agent(self, agent_id: int) -> tuple[Any, ...] | None:
        agent = next((item for item in self.agents if item.id == agent_id), None)
        if agent is None:
            return None
        return (
            agent.id,
            self._compact_poi_summary(
                agent.origin_poi,
                agent.origin_snap_distance_meters,
                agent.origin_poi_kind,
            ),
            self._compact_poi_summary(
                agent.destination_poi,
                agent.destination_snap_distance_meters,
                agent.destination_poi_kind,
            ),
        )

    def selected_route_snapshot(
        self, agent_id: int, known_route_token: str | None
    ) -> dict[str, Any] | None:
        agent = next((item for item in self.agents if item.id == agent_id), None)
        if agent is None:
            return None

        route_edge_ids = agent.route_edge_ids
        token = (
            blake2s("\0".join(route_edge_ids).encode("utf-8"), digest_size=8).hexdigest()
            if route_edge_ids
            else None
        )
        selected_route: dict[str, Any] = {
            "agentId": agent.id,
            "mode": agent.mode,
            "token": token,
            "routeIndex": agent.route_index,
        }
        if token is None:
            selected_route["nodeIds"] = []
        elif token != known_route_token:
            first_edge = self.network.edges_by_id[route_edge_ids[0]]
            selected_route["nodeIds"] = [
                first_edge.from_node,
                *(self.network.edges_by_id[edge_id].to_node for edge_id in route_edge_ids),
            ]
        return selected_route

    def snapshot(
        self,
        selected_agent_id: int | None = None,
        known_route_token: str | None = None,
    ) -> dict[str, Any]:
        agents = []
        for agent in self.agents:
            latitude, longitude = self._agent_position(agent)
            agents.append(
                {
                    "id": agent.id,
                    "mode": agent.mode,
                    "lat": round(latitude, 7),
                    "lng": round(longitude, 7),
                    "heading": round(agent.edge.bearing, 1),
                    "waiting": agent.wait_seconds > 0,
                    "lane": agent.lane_index,
                    "originPoi": (
                        agent.origin_poi.summary(
                            snap_distance_meters=agent.origin_snap_distance_meters,
                            kind=agent.origin_poi_kind,
                        )
                        if agent.origin_poi is not None
                        else None
                    ),
                    "destinationPoi": (
                        agent.destination_poi.summary(
                            snap_distance_meters=(
                                agent.destination_snap_distance_meters
                            ),
                            kind=agent.destination_poi_kind,
                        )
                        if agent.destination_poi is not None
                        else None
                    ),
                }
            )
        snapshot = {
            "agents": agents,
            "stats": self.stats(),
            "routing": {
                mode: dict(values)
                for mode, values in self.route_selection_stats.items()
            },
        }
        if selected_agent_id is not None:
            snapshot["selectedRoute"] = self.selected_route_snapshot(
                selected_agent_id, known_route_token
            )
        return snapshot

    def stats(self) -> dict[str, int | float]:
        cars = [agent for agent in self.agents if agent.mode == "car"]
        pedestrians = [agent for agent in self.agents if agent.mode == "pedestrian"]

        def average_speed(agents: list[NetworkAgent]) -> float:
            return (
                sum(agent.current_speed_mps for agent in agents) / len(agents)
                if agents
                else 0.0
            )

        congestion = (
            sum(
                1 - agent.current_speed_mps / agent.desired_speed_mps
                for agent in self.agents
                if agent.desired_speed_mps > 0
            )
            / len(self.agents)
            if self.agents
            else 0.0
        )
        return {
            "cars": len(cars),
            "pedestrians": len(pedestrians),
            "averageCarSpeedKph": average_speed(cars) * 3.6,
            "averagePedestrianSpeedKph": average_speed(pedestrians) * 3.6,
            "congestionPercent": _clamp(congestion * 100, 0.0, 100.0),
            "waitingAgents": sum(agent.wait_seconds > 0 for agent in self.agents),
            "completedTrips": self.completed_trips,
            "gatewayExits": self.gateway_exits,
            "gatewayEntries": self.gateway_entries,
            "routeReseeds": self.route_reseeds,
            "activeTrips": sum(
                bool(agent.route_edge_ids and agent.destination_poi is not None)
                for agent in self.agents
            ),
            "elapsedSeconds": self.elapsed_seconds,
        }
