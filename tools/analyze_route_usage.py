"""Analyze deterministic edge usage in the active offline route catalog."""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import gzip
import json
from math import ceil
from pathlib import Path
import sys
from typing import Any, Iterable, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from traffic_simulator.console import configure_utf8_stdio  # noqa: E402
from traffic_simulator.process_runtime import apply_safe_process_runtime  # noqa: E402
from traffic_simulator.network_simulation import (  # noqa: E402
    NetworkTrafficSimulation,
    RoadNetwork,
)


DEFAULT_NETWORK = PROJECT_ROOT / "data" / "ujbuda_network.json.gz"
DEFAULT_CATALOG = PROJECT_ROOT / "data" / "ujbuda_route_catalog.json.gz"
DEFAULT_MODES = ("car", "pedestrian")
MODE_LABELS = {"car": "Autó", "pedestrian": "Gyalogos"}


@dataclass(frozen=True, slots=True)
class CatalogRoute:
    origin_id: str
    destination_id: str
    edge_ids: tuple[str, ...]


def _positive_integer(raw: str) -> int:
    value = int(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("pozitív egész szám szükséges")
    return value


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "A fix OSM-hálózat aktív A-B útvonalkatalógusának determinisztikus, "
            "offline élhasználati elemzése."
        )
    )
    parser.add_argument(
        "--network",
        type=Path,
        default=DEFAULT_NETWORK,
        help=f"A feldolgozott gzip JSON (alapérték: {DEFAULT_NETWORK})",
    )
    parser.add_argument(
        "--mode",
        dest="modes",
        choices=DEFAULT_MODES,
        action="append",
        help="Vizsgált mód; többször megadható (alapérték: mindkettő).",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=DEFAULT_CATALOG,
        help=(
            "Előre generált útvonalkatalógus; ha nem létezik, az elemző "
            "helyben építi fel."
        ),
    )
    parser.add_argument(
        "--rare-threshold",
        type=_positive_integer,
        default=2,
        help="Legfeljebb ennyi előfordulás számít ritkának (alapérték: 2).",
    )
    parser.add_argument(
        "--grid-size",
        type=_positive_integer,
        default=48,
        help="A földrajzi lefedettség rácsmérete (alapérték: 48).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="A szimuláció determinisztikus seedje (alapérték: 42).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Embernek szánt összegzés helyett JSON-kimenet.",
    )
    return parser


def _gini_coefficient(values: Sequence[int]) -> float:
    ordered = sorted(max(0, int(value)) for value in values)
    total = sum(ordered)
    count = len(ordered)
    if not total or not count:
        return 0.0
    weighted_sum = sum(
        (2 * index - count - 1) * value
        for index, value in enumerate(ordered, start=1)
    )
    return weighted_sum / (count * total)


def _top_share(values: Sequence[int], fraction: float) -> float:
    total = sum(values)
    if not total or not values:
        return 0.0
    take = max(1, ceil(len(values) * fraction))
    return sum(sorted(values, reverse=True)[:take]) / total


def _network_bounds(network: RoadNetwork) -> tuple[float, float, float, float]:
    raw_bounds = network.meta.get("bounds") or {}
    try:
        return (
            float(raw_bounds["south"]),
            float(raw_bounds["west"]),
            float(raw_bounds["north"]),
            float(raw_bounds["east"]),
        )
    except (KeyError, TypeError, ValueError):
        latitudes = [node.latitude for node in network.nodes.values()]
        longitudes = [node.longitude for node in network.nodes.values()]
        return (
            min(latitudes),
            min(longitudes),
            max(latitudes),
            max(longitudes),
        )


def _grid_cell(
    latitude: float,
    longitude: float,
    bounds: tuple[float, float, float, float],
    grid_size: int,
) -> tuple[int, int]:
    south, west, north, east = bounds
    latitude_span = max(1e-12, north - south)
    longitude_span = max(1e-12, east - west)
    row = int((float(latitude) - south) / latitude_span * grid_size)
    column = int((float(longitude) - west) / longitude_span * grid_size)
    return (
        max(0, min(grid_size - 1, row)),
        max(0, min(grid_size - 1, column)),
    )


def _catalog_routes(
    simulation: NetworkTrafficSimulation, mode: str
) -> tuple[list[CatalogRoute], int, int]:
    routes: list[CatalogRoute] = []
    empty_routes = 0
    invalid_routes = 0
    edge_ids = simulation.network.edges_by_id
    for origin_id in sorted(simulation.route_successors[mode]):
        destinations = sorted(
            simulation.route_successors[mode][origin_id],
            key=lambda destination: destination.poi.id,
        )
        for destination in destinations:
            route_edge_ids = tuple(
                simulation.route_cache.get(
                    (mode, origin_id, destination.poi.id), ()
                )
                or ()
            )
            if not route_edge_ids:
                empty_routes += 1
                continue
            if any(edge_id not in edge_ids for edge_id in route_edge_ids):
                invalid_routes += 1
                continue
            routes.append(
                CatalogRoute(
                    origin_id=origin_id,
                    destination_id=destination.poi.id,
                    edge_ids=route_edge_ids,
                )
            )
    return routes, empty_routes, invalid_routes


def _way_history(network: RoadNetwork, edge_ids: Iterable[str]) -> tuple[int, ...]:
    history: tuple[int, ...] = ()
    for edge_id in edge_ids:
        history = network.extend_way_history(
            history, network.edges_by_id[edge_id].way_id
        )
    return history


def _transition_compatibility(
    network: RoadNetwork,
    simulation: NetworkTrafficSimulation,
    mode: str,
    routes: Sequence[CatalogRoute],
) -> dict[str, int | float]:
    route_by_pair = {
        (route.origin_id, route.destination_id): route for route in routes
    }
    candidate_count = 0
    compatible_count = 0
    immediate_reverse_count = 0
    incoming_without_compatible = 0

    for incoming in routes:
        incoming_edge = network.edges_by_id[incoming.edge_ids[-1]]
        history = _way_history(network, incoming.edge_ids)
        allowed_first_ids = {
            edge.id
            for edge in network.allowed_outgoing(
                incoming_edge, mode, history
            )
        }
        compatible_for_incoming = 0
        destinations = simulation.route_successors[mode].get(
            incoming.destination_id, ()
        )
        for destination in destinations:
            outgoing = route_by_pair.get(
                (incoming.destination_id, destination.poi.id)
            )
            if outgoing is None:
                continue
            first_edge = network.edges_by_id[outgoing.edge_ids[0]]
            candidate_count += 1
            direction_matches = first_edge.from_node == incoming_edge.to_node
            if direction_matches and first_edge.id in allowed_first_ids:
                compatible_count += 1
                compatible_for_incoming += 1
            if (
                direction_matches
                and first_edge.segment_id == incoming_edge.segment_id
                and first_edge.to_node == incoming_edge.from_node
            ):
                immediate_reverse_count += 1
        if destinations and compatible_for_incoming == 0:
            incoming_without_compatible += 1

    return {
        "transitionCandidateCount": candidate_count,
        "transitionCompatibleCount": compatible_count,
        "transitionCompatiblePercent": (
            100.0 * compatible_count / candidate_count
            if candidate_count
            else 0.0
        ),
        "transitionImmediateReverseCount": immediate_reverse_count,
        "transitionImmediateReversePercent": (
            100.0 * immediate_reverse_count / candidate_count
            if candidate_count
            else 0.0
        ),
        "incomingRoutesWithoutCompatibleSuccessor": incoming_without_compatible,
    }


def analyze_mode(
    network: RoadNetwork,
    simulation: NetworkTrafficSimulation,
    mode: str,
    *,
    rare_threshold: int = 2,
    grid_size: int = 48,
) -> dict[str, Any]:
    if rare_threshold <= 0 or grid_size <= 0:
        raise ValueError("A ritkasági küszöb és a rácsméret legyen pozitív.")

    routes, empty_routes, invalid_routes = _catalog_routes(simulation, mode)
    network_edges = tuple(network.edges_by_mode[mode])
    usage = Counter(
        edge_id for route in routes for edge_id in route.edge_ids
    )
    usage_values = [usage.get(edge.id, 0) for edge in network_edges]
    used_edge_count = sum(value > 0 for value in usage_values)
    never_edge_count = len(network_edges) - used_edge_count
    rare_edge_count = sum(
        0 < value <= rare_threshold for value in usage_values
    )

    repeated_physical_segment_routes = 0
    looping_routes = 0
    origin_first_edge_compatible = 0
    for route in routes:
        edges = [network.edges_by_id[edge_id] for edge_id in route.edge_ids]
        segment_ids = [edge.segment_id for edge in edges]
        if len(set(segment_ids)) < len(segment_ids):
            repeated_physical_segment_routes += 1
        visited_nodes = [edges[0].from_node, *(edge.to_node for edge in edges)]
        if len(set(visited_nodes)) < len(visited_nodes):
            looping_routes += 1
        origin = simulation.route_pois_by_id[mode].get(route.origin_id)
        if origin is not None and edges[0].from_node == origin.node_id:
            origin_first_edge_compatible += 1

    bounds = _network_bounds(network)
    network_cells = {
        _grid_cell(
            (edge.start[0] + edge.end[0]) / 2,
            (edge.start[1] + edge.end[1]) / 2,
            bounds,
            grid_size,
        )
        for edge in network_edges
    }
    route_cells = {
        _grid_cell(
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
            bounds,
            grid_size,
        )
        for edge_id in usage
    }

    transition_metrics = _transition_compatibility(
        network, simulation, mode, routes
    )
    edge_count = len(network_edges)
    route_count = len(routes)
    return {
        "mode": mode,
        "catalogPairCount": route_count + empty_routes + invalid_routes,
        "routeCount": route_count,
        "emptyRouteCount": empty_routes,
        "invalidRouteCount": invalid_routes,
        "networkEdgeCount": edge_count,
        "usedEdgeCount": used_edge_count,
        "neverUsedEdgeCount": never_edge_count,
        "neverUsedEdgePercent": (
            100.0 * never_edge_count / edge_count if edge_count else 0.0
        ),
        "rareThreshold": rare_threshold,
        "rareEdgeCount": rare_edge_count,
        "rareEdgePercent": (
            100.0 * rare_edge_count / edge_count if edge_count else 0.0
        ),
        "rareAmongUsedEdgePercent": (
            100.0 * rare_edge_count / used_edge_count
            if used_edge_count
            else 0.0
        ),
        "top1PercentEdgeTraversalShare": 100.0
        * _top_share(usage_values, 0.01),
        "top5PercentEdgeTraversalShare": 100.0
        * _top_share(usage_values, 0.05),
        "giniAllEdges": _gini_coefficient(usage_values),
        "gridSize": grid_size,
        "networkGridCellCount": len(network_cells),
        "routeGridCellCount": len(route_cells),
        "routeGridCellCoveragePercent": (
            100.0 * len(route_cells) / len(network_cells)
            if network_cells
            else 0.0
        ),
        "repeatedPhysicalSegmentRouteCount": repeated_physical_segment_routes,
        "repeatedPhysicalSegmentRoutePercent": (
            100.0 * repeated_physical_segment_routes / route_count
            if route_count
            else 0.0
        ),
        "loopingRouteCount": looping_routes,
        "loopingRoutePercent": (
            100.0 * looping_routes / route_count if route_count else 0.0
        ),
        "originFirstEdgeCompatibleCount": origin_first_edge_compatible,
        "originFirstEdgeCompatiblePercent": (
            100.0 * origin_first_edge_compatible / route_count
            if route_count
            else 0.0
        ),
        **transition_metrics,
    }


def _format_percent(value: Any) -> str:
    return f"{float(value):.2f}%"


def _print_text(path: Path, reports: Sequence[dict[str, Any]]) -> None:
    print(f"Hálózat: {path}")
    for report in reports:
        print(f"\n{MODE_LABELS.get(str(report['mode']), report['mode'])}")
        print(
            "  Aktív útvonalak: "
            f"{report['routeCount']} / {report['catalogPairCount']} katalóguspár"
        )
        print(
            "  Élek: "
            f"{report['usedEdgeCount']} / {report['networkEdgeCount']} használt; "
            f"soha {report['neverUsedEdgeCount']} "
            f"({_format_percent(report['neverUsedEdgePercent'])}); "
            f"ritka <= {report['rareThreshold']}: {report['rareEdgeCount']} "
            f"({_format_percent(report['rareEdgePercent'])})"
        )
        print(
            "  Koncentráció: "
            f"top 1% = {_format_percent(report['top1PercentEdgeTraversalShare'])}; "
            f"top 5% = {_format_percent(report['top5PercentEdgeTraversalShare'])}; "
            f"Gini = {report['giniAllEdges']:.4f}"
        )
        print(
            f"  {report['gridSize']}x{report['gridSize']} cellalefedettség: "
            f"{report['routeGridCellCount']} / {report['networkGridCellCount']} "
            f"({_format_percent(report['routeGridCellCoveragePercent'])})"
        )
        print(
            "  Hurkok: "
            f"ismételt fizikai szegmens "
            f"{report['repeatedPhysicalSegmentRouteCount']} "
            f"({_format_percent(report['repeatedPhysicalSegmentRoutePercent'])}); "
            f"ismételt csomópont {report['loopingRouteCount']} "
            f"({_format_percent(report['loopingRoutePercent'])})"
        )
        print(
            "  Első él az origóból helyes irányú: "
            f"{report['originFirstEdgeCompatibleCount']} / {report['routeCount']} "
            f"({_format_percent(report['originFirstEdgeCompatiblePercent'])})"
        )
        print(
            "  Érkezés utáni következő első él kompatibilis: "
            f"{report['transitionCompatibleCount']} / "
            f"{report['transitionCandidateCount']} "
            f"({_format_percent(report['transitionCompatiblePercent'])}); "
            f"kompatibilis utód nélküli érkező út: "
            f"{report['incomingRoutesWithoutCompatibleSuccessor']}"
        )
        print(
            "  Azonnali visszafordulásra mutató utódjelölt: "
            f"{report['transitionImmediateReverseCount']} / "
            f"{report['transitionCandidateCount']} "
            f"({_format_percent(report['transitionImmediateReversePercent'])})"
        )
        if report["emptyRouteCount"] or report["invalidRouteCount"]:
            print(
                "  Hibás katalógusbejegyzések: "
                f"üres={report['emptyRouteCount']}, "
                f"ismeretlen él={report['invalidRouteCount']}"
            )


def main(argv: list[str] | None = None) -> int:
    apply_safe_process_runtime()
    configure_utf8_stdio()
    arguments = argument_parser().parse_args(argv)
    path = arguments.network.expanduser().resolve()
    try:
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
        route_catalog = None
        catalog_path = arguments.catalog.expanduser().resolve()
        if catalog_path.is_file():
            with gzip.open(catalog_path, "rt", encoding="utf-8") as stream:
                route_catalog = json.load(stream)
        network = RoadNetwork(payload)
        simulation = NetworkTrafficSimulation(
            network,
            cars=0,
            pedestrians=0,
            seed=arguments.seed,
            route_catalog=route_catalog,
        )
        modes = tuple(dict.fromkeys(arguments.modes or DEFAULT_MODES))
        reports = [
            analyze_mode(
                network,
                simulation,
                mode,
                rare_threshold=arguments.rare_threshold,
                grid_size=arguments.grid_size,
            )
            for mode in modes
        ]
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        print(f"Elemzési hiba: {error}", file=sys.stderr)
        return 1

    if arguments.json:
        print(
            json.dumps(
                {"network": str(path), "modes": reports},
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
    else:
        _print_text(path, reports)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
