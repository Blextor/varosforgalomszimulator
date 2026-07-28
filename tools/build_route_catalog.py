"""Build the fixed, offline Újbuda A-B route catalog."""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from traffic_simulator.console import configure_utf8_stdio  # noqa: E402
from traffic_simulator.process_runtime import apply_safe_process_runtime  # noqa: E402
from traffic_simulator.network_simulation import (  # noqa: E402
    NetworkTrafficSimulation,
    RoadNetwork,
)
from traffic_simulator.osm_network import write_network_gzip  # noqa: E402

DEFAULT_NETWORK = PROJECT_ROOT / "data" / "ujbuda_network.json.gz"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "ujbuda_route_catalog.json.gz"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "A fix OSM-gráf sokútvonalas, hálózati kérés nélküli "
            "A-B katalógusának elkészítése"
        )
    )
    parser.add_argument("--network", type=Path, default=DEFAULT_NETWORK)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--warm-only",
        action="store_true",
        help="Csak az induláshoz szükséges előmelegített utakat menti.",
    )
    return parser.parse_args()


def main() -> int:
    apply_safe_process_runtime()
    configure_utf8_stdio()
    arguments = parse_arguments()
    started = time.perf_counter()
    try:
        with gzip.open(arguments.network, "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
        network = RoadNetwork(payload)
        simulation = NetworkTrafficSimulation(
            network, cars=0, pedestrians=0, seed=42
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"A hálózat nem tölthető be: {error}", file=sys.stderr)
        return 1

    if not arguments.warm_only:
        for mode in ("car", "pedestrian"):
            for origin_id, destinations in simulation.route_successors[mode].items():
                origin = simulation.route_pois_by_id[mode][origin_id]
                for destination in destinations:
                    simulation._cached_route(mode, origin, destination)

    for mode in ("car", "pedestrian"):
        simulation.route_selection_stats[mode]["cachedRoutes"] = sum(
            bool(route)
            for (route_mode, _, _), route in simulation.route_cache.items()
            if route_mode == mode
        )
    catalog = simulation.export_route_catalog()
    try:
        write_network_gzip(catalog, arguments.output)
    except OSError as error:
        print(f"A katalógus nem írható ki: {error}", file=sys.stderr)
        return 1

    print(
        f"Katalógus: {arguments.output.resolve()} "
        f"({arguments.output.stat().st_size / 1024 / 1024:.2f} MiB)"
    )
    for mode, label in (("car", "Autó"), ("pedestrian", "Gyalogos")):
        routes = sum(
            bool(route)
            for (route_mode, _, _), route in simulation.route_cache.items()
            if route_mode == mode
        )
        print(
            f"{label}: {len(simulation.route_pois_by_mode[mode])} horgony, "
            f"{routes} eltárolt út"
        )
    print(f"Idő: {time.perf_counter() - started:.2f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
