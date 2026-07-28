"""Validate the generated XI district graph and run a small performance check."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import json
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from traffic_simulator.network_simulation import (  # noqa: E402
    NetworkTrafficSimulation,
    PEDESTRIAN_MAJOR_HIGHWAYS,
    RoadNetwork,
)
from traffic_simulator.console import configure_utf8_stdio  # noqa: E402
from traffic_simulator.process_runtime import apply_safe_process_runtime  # noqa: E402

DEFAULT_NETWORK = PROJECT_ROOT / "data" / "ujbuda_network.json.gz"
DEFAULT_CATALOG = PROJECT_ROOT / "data" / "ujbuda_route_catalog.json.gz"


def _weak_component_sizes(network: RoadNetwork, mode: str) -> list[int]:
    adjacency: dict[int, set[int]] = defaultdict(set)
    for edge in network.edges_by_mode[mode]:
        adjacency[edge.from_node].add(edge.to_node)
        adjacency[edge.to_node].add(edge.from_node)

    remaining = set(adjacency)
    sizes: list[int] = []
    while remaining:
        start = remaining.pop()
        stack = [start]
        size = 0
        while stack:
            node_id = stack.pop()
            size += 1
            for neighbour in adjacency[node_id]:
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    stack.append(neighbour)
        sizes.append(size)
    return sorted(sizes, reverse=True)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="XI. kerületi OSM gráf ellenőrzése")
    parser.add_argument("--network", type=Path, default=DEFAULT_NETWORK)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--cars", type=int, default=400)
    parser.add_argument("--pedestrians", type=int, default=600)
    parser.add_argument("--steps", type=int, default=120)
    return parser.parse_args()


def main() -> int:
    apply_safe_process_runtime()
    configure_utf8_stdio()
    arguments = parse_arguments()
    path = arguments.network.expanduser().resolve()
    load_started = time.perf_counter()
    try:
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
        network = RoadNetwork(payload)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"Hibás hálózati fájl: {error}", file=sys.stderr)
        return 1

    node_ids = set(network.nodes)
    missing_node_references = sum(
        edge.from_node not in node_ids or edge.to_node not in node_ids
        for edge in network.edges
    )
    if missing_node_references:
        print(
            f"Hiba: {missing_node_references} él nem létező csomópontra hivatkozik.",
            file=sys.stderr,
        )
        return 1
    network_load_elapsed = time.perf_counter() - load_started

    for mode in ("car", "pedestrian"):
        component_sizes = _weak_component_sizes(network, mode)
        if len(component_sizes) > 1:
            print(
                f"Hiba: a(z) {mode} gráf még {len(component_sizes)} különálló "
                "komponensből áll.",
                file=sys.stderr,
            )
            return 1

    simulation_started = time.perf_counter()
    route_catalog = None
    catalog_path = arguments.catalog.expanduser().resolve()
    if catalog_path.is_file():
        try:
            with gzip.open(catalog_path, "rt", encoding="utf-8") as stream:
                route_catalog = json.load(stream)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            print(f"Hibás útvonalkatalógus: {error}", file=sys.stderr)
            return 1
    simulation = NetworkTrafficSimulation(
        network,
        cars=arguments.cars,
        pedestrians=arguments.pedestrians,
        seed=42,
        route_catalog=route_catalog,
    )
    simulation_prepare_elapsed = time.perf_counter() - simulation_started
    visited_edges: dict[str, set[str]] = {
        "car": set(),
        "pedestrian": set(),
    }
    edge_occupancy: dict[str, Counter[str]] = {
        "car": Counter(),
        "pedestrian": Counter(),
    }
    visited_od_pairs: dict[str, set[tuple[str, str]]] = {
        "car": set(),
        "pedestrian": set(),
    }
    started = time.perf_counter()
    for _ in range(max(0, arguments.steps)):
        simulation.step(0.5)
        for agent in simulation.agents:
            visited_edges[agent.mode].add(agent.edge.id)
            edge_occupancy[agent.mode][agent.edge.id] += 1
            if agent.origin_poi is not None and agent.destination_poi is not None:
                visited_od_pairs[agent.mode].add(
                    (agent.origin_poi.id, agent.destination_poi.id)
                )
    elapsed = time.perf_counter() - started
    snapshot = simulation.snapshot()
    metadata = payload.get("meta", {})
    node_rules = sum(len(rules) for rules in network.turn_rules.values())
    via_way_rules = sum(len(rules) for rules in network.sequence_turn_rules.values())
    pedestrian_only_edges = sum(
        "pedestrian" in edge.modes and "car" not in edge.modes for edge in network.edges
    )
    poi_categories: dict[str, int] = defaultdict(int)
    for poi in payload.get("pois", []):
        poi_categories[str(poi.get("category") or "other")] += 1
    if poi_categories and snapshot["stats"].get("activeTrips") != len(snapshot["agents"]):
        print(
            "Hiba: nem minden ágens kapott folyamatos POI-alapú A-B útvonalat.",
            file=sys.stderr,
        )
        return 1

    active_route_edges: dict[str, set[str]] = {
        "car": set(),
        "pedestrian": set(),
    }
    active_route_lengths: dict[str, list[float]] = {
        "car": [],
        "pedestrian": [],
    }
    for mode, successors in simulation.route_successors.items():
        for origin_id, destinations in successors.items():
            for destination in destinations:
                route_edge_ids = (
                    simulation.route_cache.get(
                        (mode, origin_id, destination.poi.id), ()
                    )
                    or ()
                )
                active_route_edges[mode].update(route_edge_ids)
                active_route_lengths[mode].append(
                    sum(
                        network.edges_by_id[edge_id].length_meters
                        for edge_id in route_edge_ids
                    )
                )

    def percentile(values: list[float], fraction: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        index = int(round((len(ordered) - 1) * fraction))
        return ordered[max(0, min(len(ordered) - 1, index))]

    network_fine_cells: dict[str, set[tuple[int, int]]] = {
        mode: {
            simulation._fine_grid_cell(
                (edge.start[0] + edge.end[0]) / 2,
                (edge.start[1] + edge.end[1]) / 2,
            )
            for edge in network.edges_by_mode[mode]
        }
        for mode in ("car", "pedestrian")
    }
    route_fine_cells: dict[str, set[tuple[int, int]]] = {
        mode: {
            simulation._fine_grid_cell(
                (
                    network.edges_by_id[edge_id].start[0]
                    + network.edges_by_id[edge_id].end[0]
                )
                / 2,
                (
                    network.edges_by_id[edge_id].start[1]
                    + network.edges_by_id[edge_id].end[1]
                )
                / 2,
            )
            for edge_id in active_route_edges[mode]
        }
        for mode in ("car", "pedestrian")
    }

    forbidden_highways = {
        "car": {"footway", "path", "steps", "corridor", "platform", "pedestrian"},
        "pedestrian": {"corridor", "platform"},
    }
    if simulation_prepare_elapsed > 10.0:
        print(
            "Hiba: a szimuláció útvonal-előkészítése túllépte a 10 másodpercet: "
            f"{simulation_prepare_elapsed:.2f} s.",
            file=sys.stderr,
        )
        return 1

    for mode in ("car", "pedestrian"):
        forbidden_route_edges = [
            edge_id
            for edge_id in active_route_edges[mode]
            if network.edges_by_id[edge_id].highway in forbidden_highways[mode]
        ]
        if forbidden_route_edges:
            print(
                f"Hiba: {len(forbidden_route_edges)} tiltott {mode} útvonalél maradt.",
                file=sys.stderr,
            )
            return 1
        routing = simulation.route_selection_stats[mode]
        minimum_anchors = 60 if mode == "car" else 75
        minimum_gateway_anchors = 8 if mode == "car" else 4
        minimum_grid_cells = 40
        if (
            int(routing.get("viableAnchors", 0)) < minimum_anchors
            or int(routing.get("viableGatewayAnchors", 0))
            < minimum_gateway_anchors
            or int(routing.get("viableGridCells", 0)) < minimum_grid_cells
        ):
            print(
                f"Hiba: a(z) {mode} A-B célkészlete nem elég sokszínű: {routing}",
                file=sys.stderr,
            )
            return 1
        if int(routing.get("successorMinimum", 0)) < 2:
            print(
                f"Hiba: a(z) {mode} horgonyokhoz nem maradt legalább két cél: "
                f"{routing}",
                file=sys.stderr,
            )
            return 1
        active_od_pairs = sum(
            len(destinations)
            for destinations in simulation.route_successors[mode].values()
        )
        if active_od_pairs < 2 * int(routing["viableAnchors"]):
            print(
                f"Hiba: a(z) {mode} aktív OD-párjai nem fedik le kétszer a "
                f"horgonyokat: {active_od_pairs}.",
                file=sys.stderr,
            )
            return 1
        minimum_seen_pairs = int(routing["viableAnchors"]) + 10
        if len(visited_od_pairs[mode]) < minimum_seen_pairs:
            print(
                f"Hiba: a(z) {mode} ágensek csak {len(visited_od_pairs[mode])} "
                f"külön OD-párt használtak (minimum {minimum_seen_pairs}).",
                file=sys.stderr,
            )
            return 1

        route_coverage = (
            100 * len(active_route_edges[mode]) / len(network.edges_by_mode[mode])
        )
        minimum_route_coverage = 18.0 if mode == "car" else 9.0
        if route_coverage < minimum_route_coverage:
            print(
                f"Hiba: a(z) {mode} útvonalél-lefedettség csak "
                f"{route_coverage:.2f}% (minimum {minimum_route_coverage:.0f}%).",
                file=sys.stderr,
            )
            return 1
        fine_cell_coverage = (
            100
            * len(route_fine_cells[mode])
            / max(1, len(network_fine_cells[mode]))
        )
        minimum_fine_cell_coverage = 50.0 if mode == "car" else 48.0
        if fine_cell_coverage < minimum_fine_cell_coverage:
            print(
                f"Hiba: a(z) {mode} 48x48 cellalefedettség csak "
                f"{fine_cell_coverage:.2f}% (minimum "
                f"{minimum_fine_cell_coverage:.0f}%).",
                file=sys.stderr,
            )
            return 1
        snap_limit = 200.0 if mode == "car" else 120.0
        if float(routing.get("maxSnapDistanceMeters", snap_limit + 1)) > snap_limit:
            print(
                f"Hiba: a(z) {mode} POI-snap túllépi a {snap_limit:.0f} m limitet.",
                file=sys.stderr,
            )
            return 1

        if mode == "pedestrian":
            route_lengths = active_route_lengths[mode]
            median_length = percentile(route_lengths, 0.5)
            p90_length = percentile(route_lengths, 0.9)
            local_share = (
                sum(length < 2_000 for length in route_lengths)
                / max(1, len(route_lengths))
            )
            if median_length >= 2_000 or p90_length >= 5_500 or local_share <= 0.5:
                print(
                    "Hiba: a gyalogos utak nem eléggé lokálisak: "
                    f"medián={median_length:.0f} m, p90={p90_length:.0f} m, "
                    f"2 km alatti arány={100 * local_share:.1f}%.",
                    file=sys.stderr,
                )
                return 1
            route_major_percent = (
                100
                * sum(
                    network.edges_by_id[edge_id].highway
                    in PEDESTRIAN_MAJOR_HIGHWAYS
                    for edge_id in active_route_edges[mode]
                )
                / max(1, len(active_route_edges[mode]))
            )
            network_major_percent = (
                100
                * sum(
                    edge.highway in PEDESTRIAN_MAJOR_HIGHWAYS
                    for edge in network.edges_by_mode[mode]
                )
                / len(network.edges_by_mode[mode])
            )
            route_major_bias = route_major_percent / max(
                0.01, network_major_percent
            )
            occupancy_total = sum(edge_occupancy[mode].values())
            occupancy_major_percent = (
                100
                * sum(
                    count
                    for edge_id, count in edge_occupancy[mode].items()
                    if network.edges_by_id[edge_id].highway
                    in PEDESTRIAN_MAJOR_HIGHWAYS
                )
                / max(1, occupancy_total)
            )
            occupancy_major_bias = occupancy_major_percent / max(
                0.01, network_major_percent
            )
            if route_major_bias > 3.25 or occupancy_major_bias > 4.5:
                print(
                    "Hiba: a gyalogos főúti torzítás túl nagy: "
                    f"útvonal={route_major_bias:.2f}x, "
                    f"megfigyelt={occupancy_major_bias:.2f}x.",
                    file=sys.stderr,
                )
                return 1
            pedestrian_gateway_highways = set(
                routing.get("gatewayHighways", {})
            )
            if pedestrian_gateway_highways & PEDESTRIAN_MAJOR_HIGHWAYS:
                print(
                    "Hiba: gyalogos peremkapu főútra került: "
                    f"{sorted(pedestrian_gateway_highways)}.",
                    file=sys.stderr,
                )
                return 1

    print(f"Hálózat: {metadata.get('networkId', 'ismeretlen')}")
    print(f"OSM-pillanatkép: {metadata.get('osmTimestamp', 'ismeretlen')}")
    print(f"Tömörített méret: {path.stat().st_size / 1024 / 1024:.2f} MiB")
    print(
        f"Csomópontok: {len(network.nodes)}, élek: {len(network.edges)}, "
        f"autós élek: {len(network.edges_by_mode['car'])}, "
        f"gyalogos élek: {len(network.edges_by_mode['pedestrian'])}"
    )
    print(f"Csak gyalogos élek: {pedestrian_only_edges}")
    print(
        f"POI-k: {sum(poi_categories.values())} "
        f"({', '.join(f'{key}={value}' for key, value in sorted(poi_categories.items()))})"
    )
    print(
        f"Aktív kanyarodási szabályok: {node_rules + via_way_rules} "
        f"({node_rules} via-node, {via_way_rules} via-way)"
    )
    pruning = metadata.get("pruning", {})
    if pruning.get("removed"):
        removed = pruning["removed"]
        print(
            "Csupaszítás: "
            f"-{removed.get('nodes', 0)} csomópont, "
            f"-{removed.get('segments', 0)} szegmens, "
            f"-{removed.get('edges', 0)} él"
        )
    print(
        f"Aktív POI A-B utak: {snapshot['stats'].get('activeTrips', 0)} / "
        f"{len(snapshot['agents'])}"
    )
    print(
        f"Indítás: hálózat {network_load_elapsed:.3f} s, "
        f"OD-előkészítés {simulation_prepare_elapsed:.3f} s"
    )
    for mode, label in (("car", "Autó"), ("pedestrian", "Gyalogos")):
        routing = simulation.route_selection_stats[mode]
        route_coverage = (
            100 * len(active_route_edges[mode]) / len(network.edges_by_mode[mode])
        )
        visited_coverage = (
            100 * len(visited_edges[mode]) / len(network.edges_by_mode[mode])
        )
        fine_cell_coverage = (
            100
            * len(route_fine_cells[mode])
            / max(1, len(network_fine_cells[mode]))
        )
        route_lengths = active_route_lengths[mode]
        print(
            f"{label} POI: {routing['eligibleCandidates']} alkalmas, "
            f"{routing['shortlistCandidates']} shortlist, "
            f"{routing['snappableCatalogCandidates']} snapelt katalóguselem; "
            f"OD: {routing['viableAnchors']} horgony, "
            f"{routing['viableGatewayAnchors']} peremkapu, "
            f"{routing['viableGridCells']} földrajzi cella, "
            f"{routing['activeOdPairs']} aktív / "
            f"{len(visited_od_pairs[mode])} megfigyelt pár, "
            f"medián {percentile(route_lengths, 0.5):.0f} m, "
            f"p90 {percentile(route_lengths, 0.9):.0f} m, "
            f"max snap {routing['maxSnapDistanceMeters']:.1f} m, "
            f"cache-lefedettség {route_coverage:.2f}%, "
            f"48x48 cella {fine_cell_coverage:.2f}%, "
            f"megfigyelt {visited_coverage:.2f}%"
        )
        if mode == "pedestrian":
            print(
                "Gyalogos főúti arány: "
                f"útvonal {routing['majorRouteEdgePercent']:.2f}%, "
                f"hálózat {routing['majorNetworkEdgePercent']:.2f}%; "
                f"kapuk {routing['gatewayHighways']}"
            )
    print(
        f"Teljesítmény: {len(snapshot['agents'])} ágens, "
        f"{arguments.steps * 0.5:.1f} szimulált másodperc, {elapsed:.3f} s futási idő"
    )
    print("Eredmény: érvényes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
