"""Download and build the fixed OpenStreetMap graph for Budapest XI."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from traffic_simulator.osm_network import (  # noqa: E402
    DEFAULT_OVERPASS_ENDPOINT,
    DEFAULT_USER_AGENT,
    OSMNetworkError,
    UJBUDA_RELATION_ID,
    download_ujbuda_network,
)
from traffic_simulator.console import configure_utf8_stdio  # noqa: E402


DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "ujbuda_network.json.gz"


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Budapest XI. kerület egyszer letölthető OSM úthálózati gráfjának "
            "elkészítése. A futás három Overpass-kérést végez."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"A feldolgozott gzip JSON célja (alapérték: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--endpoint",
        default=DEFAULT_OVERPASS_ENDPOINT,
        help="Overpass interpreter végpont.",
    )
    parser.add_argument(
        "--poi-endpoint",
        help=(
            "Opcionális külön Overpass-végpont a helyszínekhez; "
            "a fő végpont rate limitje esetén hasznos."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=300.0,
        help="Egy hálózati kérés időkorlátja másodpercben (alapérték: 300).",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="Átmeneti hiba utáni újrapróbálkozások száma (alapérték: 3).",
    )
    parser.add_argument(
        "--backoff",
        type=float,
        default=2.0,
        help="Az exponenciális várakozás kezdőértéke (alapérték: 2 s).",
    )
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_USER_AGENT,
        help="Az Overpass-kérésekkel küldött azonosító.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    args = argument_parser().parse_args(argv)
    if args.retries < 0:
        print("Hiba: a --retries nem lehet negatív.", file=sys.stderr)
        return 2
    if args.timeout <= 0 or args.backoff < 0:
        print("Hiba: a timeout legyen pozitív, a backoff pedig nem negatív.", file=sys.stderr)
        return 2

    output_path = args.output.expanduser().resolve()
    print(f"XI. kerületi utak letöltése (OSM relation {UJBUDA_RELATION_ID})...")
    print(
        "A program külön kéri le az utakat, a kanyarodási "
        "korlátozásokat és a helyszíneket."
    )
    try:
        network = download_ujbuda_network(
            output_path,
            endpoint=args.endpoint,
            poi_endpoint=args.poi_endpoint,
            timeout=args.timeout,
            retries=args.retries,
            backoff_seconds=args.backoff,
            user_agent=args.user_agent,
            progress=lambda message: print(message, flush=True),
        )
    except (OSMNetworkError, OSError, ValueError) as exc:
        print(f"Letöltési hiba: {exc}", file=sys.stderr)
        return 1

    counts = network["meta"]["counts"]
    size_bytes = output_path.stat().st_size
    print(f"Elkészült: {output_path}")
    print(
        "Tartalom: "
        f"{counts['nodes']} csomópont, {counts['segments']} szegmens, "
        f"{counts['edges']} irányított él, "
        f"{counts['restrictions']} kanyarodási korlátozás, "
        f"{counts['pois']} helyszín."
    )
    print(f"Tömörített méret: {size_bytes / (1024 * 1024):.2f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
