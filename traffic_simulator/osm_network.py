"""OpenStreetMap road graph builder for the fixed Ujbuda simulation map.

The module deliberately uses only the Python standard library.  Downloading is
an explicit operation: importing this module never starts a network request.
"""

from __future__ import annotations

import gzip
import io
import json
import math
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from itertools import chain
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


UJBUDA_RELATION_ID = 221998
DEFAULT_OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"
DEFAULT_USER_AGENT = (
    "UjbudaTrafficSimulator/1.0 "
    "(one-time OpenStreetMap graph download; local educational project)"
)


class OSMNetworkError(RuntimeError):
    """Raised when Overpass data cannot be downloaded or converted safely."""


def roads_overpass_query(relation_id: int = UJBUDA_RELATION_ID) -> str:
    """Return the query for highway ways and their tagged nodes."""

    return f"""[out:json][timeout:240];
relation({int(relation_id)});
map_to_area->.ujbuda;
way(area.ujbuda)[\"highway\"]->.roads;
(.roads; >;);
out body qt;
"""


def restrictions_overpass_query(relation_id: int = UJBUDA_RELATION_ID) -> str:
    """Return the smaller boundary and turn-restriction query.

    ``>>`` recursively includes the nodes of boundary and restriction member
    ways.  That gives the builder a reliable fallback for calculating bounds
    even when an Overpass instance omits the relation ``bounds`` property.
    """

    return f"""[out:json][timeout:240];
relation({int(relation_id)});
map_to_area->.ujbuda;
(
  relation({int(relation_id)});
  relation(area.ujbuda)[\"type\"~\"^restriction\"];
)->.relations;
(.relations; >>;);
out body bb qt;
"""


def pois_overpass_query(relation_id: int = UJBUDA_RELATION_ID) -> str:
    """Return the query for trip destinations and public-transport stops."""

    return f"""[out:json][timeout:240];
relation({int(relation_id)});
map_to_area->.ujbuda;
(
  nwr(area.ujbuda)
    [~"^(amenity|shop|tourism|leisure|office|craft|healthcare|public_transport)$"~"."];
  nwr(area.ujbuda)["highway"="bus_stop"];
  nwr(area.ujbuda)["railway"~"^(tram_stop|station|halt|subway_entrance)$"];
);
out tags center qt;
"""


def fetch_overpass_json(
    query: str,
    *,
    endpoint: str = DEFAULT_OVERPASS_ENDPOINT,
    timeout: float = 300.0,
    retries: int = 3,
    backoff_seconds: float = 2.0,
    user_agent: str = DEFAULT_USER_AGENT,
    opener: Callable[..., Any] | None = None,
    sleep: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """POST one Overpass query and return its decoded JSON response.

    Transient HTTP failures, connection failures, and non-JSON overload pages
    are retried with exponential backoff.  ``opener`` and ``sleep`` are
    injectable so the behaviour can be tested without network traffic.
    """

    if not query.strip():
        raise ValueError("Az Overpass-lekérdezés nem lehet üres.")
    if retries < 0:
        raise ValueError("A retries értéke nem lehet negatív.")
    if timeout <= 0:
        raise ValueError("A timeout értékének pozitívnak kell lennie.")
    if backoff_seconds < 0:
        raise ValueError("A backoff_seconds értéke nem lehet negatív.")
    if not user_agent.strip():
        raise ValueError("Az Overpass-kéréshez User-Agent szükséges.")

    open_request = opener or urlopen
    wait = sleep or time.sleep
    request_body = urlencode({"data": query}).encode("utf-8")
    retryable_statuses = {408, 425, 429, 500, 502, 503, 504}
    last_error: BaseException | None = None

    for attempt in range(retries + 1):
        request = Request(
            endpoint,
            data=request_body,
            method="POST",
            headers={
                "User-Agent": user_agent,
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            },
        )
        retry_after: float | None = None
        try:
            with open_request(request, timeout=timeout) as response:
                raw = response.read()
                content_encoding = response.headers.get("Content-Encoding", "")
                if "gzip" in content_encoding.lower() or raw.startswith(b"\x1f\x8b"):
                    raw = gzip.decompress(raw)
                payload = json.loads(raw.decode("utf-8"))
                if isinstance(payload, Mapping) and payload.get("remark"):
                    raise OSMNetworkError(
                        f"Az Overpass hibát jelzett: {payload['remark']}"
                    )
                _elements(payload)
                return payload
        except HTTPError as exc:
            last_error = exc
            if exc.code not in retryable_statuses:
                raise OSMNetworkError(
                    f"Az Overpass HTTP {exc.code} hibával elutasította a kérést."
                ) from exc
            retry_after = _retry_after_seconds(exc.headers.get("Retry-After"))
        except (
            OSMNetworkError,
            URLError,
            TimeoutError,
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as exc:
            last_error = exc

        if attempt < retries:
            delay = retry_after
            if delay is None:
                delay = min(60.0, backoff_seconds * (2**attempt))
            wait(max(0.0, delay))

    raise OSMNetworkError(
        f"Az Overpass-lekérdezés {retries + 1} próbálkozás után sem sikerült."
    ) from last_error


def build_network(
    roads_payload: Mapping[str, Any],
    restrictions_payload: Mapping[str, Any],
    poi_payload: Mapping[str, Any] | None = None,
    *,
    relation_id: int = UJBUDA_RELATION_ID,
    generated_at: str | None = None,
    source_endpoint: str | None = None,
) -> dict[str, Any]:
    """Convert the road, restriction, and POI responses to the graph schema."""

    road_elements = _elements(roads_payload)
    supplementary_elements = _elements(restrictions_payload)
    all_nodes = _collect_nodes(chain(road_elements, supplementary_elements))
    ways = [
        element
        for element in road_elements
        if element.get("type") == "way"
        and isinstance(element.get("tags"), Mapping)
        and element["tags"].get("highway")
    ]

    segments: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    used_node_ids: set[int] = set()

    for way in sorted(ways, key=lambda item: _integer_id(item, "way")):
        way_id = _integer_id(way, "way")
        tags = _string_tags(way.get("tags"))
        node_ids = _node_id_list(way.get("nodes"))
        if len(node_ids) < 2 or _is_area(tags):
            continue

        forward_modes = _allowed_modes(tags, "forward")
        backward_modes = _allowed_modes(tags, "backward")
        if not forward_modes and not backward_modes:
            continue

        lane_data = _lane_data(tags)
        relevant_tags = _relevant_way_tags(tags)
        highway = tags["highway"]
        name = tags.get("name", "")

        for index, (from_id, to_id) in enumerate(zip(node_ids, node_ids[1:])):
            from_node = all_nodes.get(from_id)
            to_node = all_nodes.get(to_id)
            if from_node is None or to_node is None or from_id == to_id:
                continue
            length_meters = _haversine_meters(
                float(from_node["lat"]),
                float(from_node["lon"]),
                float(to_node["lat"]),
                float(to_node["lon"]),
            )
            if length_meters <= 0:
                continue

            segment_id = f"w{way_id}:{index}"
            segment = {
                "id": segment_id,
                "wayId": way_id,
                "from": from_id,
                "to": to_id,
                "highway": highway,
                "name": name,
                "totalLanes": lane_data["total"],
                "forwardLanes": lane_data["forward"],
                "backwardLanes": lane_data["backward"],
                "oneway": tags.get("oneway"),
                "onewayDirection": _oneway_direction(tags, "car"),
                "osmTags": relevant_tags,
            }
            segments.append(segment)
            used_node_ids.update((from_id, to_id))

            if forward_modes:
                edges.append(
                    _make_edge(
                        segment=segment,
                        tags=tags,
                        direction="forward",
                        from_id=from_id,
                        to_id=to_id,
                        modes=forward_modes,
                        lanes=lane_data["forward"],
                        length_meters=length_meters,
                    )
                )
            if backward_modes:
                edges.append(
                    _make_edge(
                        segment=segment,
                        tags=tags,
                        direction="backward",
                        from_id=to_id,
                        to_id=from_id,
                        modes=backward_modes,
                        lanes=lane_data["backward"],
                        length_meters=length_meters,
                    )
                )

    raw_used_node_ids = set(used_node_ids)
    restrictions = _restriction_records(supplementary_elements)
    segments, edges, restrictions, used_node_ids, pruning = (
        _prune_disconnected_network(segments, edges, restrictions)
    )
    nodes = [_node_record(all_nodes[node_id]) for node_id in sorted(used_node_ids)]
    pois = _poi_records(_elements(poi_payload) if poi_payload is not None else [])
    bounds = _find_bounds(
        supplementary_elements,
        all_nodes,
        relation_id=relation_id,
        fallback_node_ids=raw_used_node_ids,
    )
    timestamp = generated_at or datetime.now(timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    osm_timestamp = _osm_timestamp(
        roads_payload,
        restrictions_payload,
        *([poi_payload] if poi_payload is not None else []),
    )
    included_way_ids = {int(segment["wayId"]) for segment in segments}
    included_way_tags = [
        _string_tags(way.get("tags"))
        for way in ways
        if _integer_id(way, "way") in included_way_ids
    ]
    metadata: dict[str, Any] = {
        "schemaVersion": 2,
        "networkId": _network_id(osm_timestamp or timestamp),
        "source": "OpenStreetMap contributors via Overpass API",
        "license": "ODbL 1.0",
        "relationId": int(relation_id),
        "generatedAt": timestamp,
        "osmTimestamp": osm_timestamp,
        "bounds": bounds,
        "counts": {
            "nodes": len(nodes),
            "segments": len(segments),
            "edges": len(edges),
            "restrictions": len(restrictions),
            "pois": len(pois),
        },
        "poiCategories": _category_counts(pois),
        "pruning": pruning,
        "coverage": {
            "ways": len(included_way_ids),
            "waysWithLanes": sum(
                any(key == "lanes" or key.startswith("lanes:") for key in tags)
                for tags in included_way_tags
            ),
            "waysWithTurnLanes": sum(
                any(key == "turn:lanes" or key.startswith("turn:lanes:") for key in tags)
                for tags in included_way_tags
            ),
            "waysWithMaxspeed": sum(
                any(key == "maxspeed" or key.startswith("maxspeed:") for key in tags)
                for tags in included_way_tags
            ),
        },
    }
    if source_endpoint:
        metadata["sourceEndpoint"] = source_endpoint

    return {
        "meta": metadata,
        "nodes": nodes,
        "segments": segments,
        "edges": edges,
        "restrictions": restrictions,
        "pois": pois,
    }


def download_ujbuda_network(
    output_path: str | os.PathLike[str],
    *,
    endpoint: str = DEFAULT_OVERPASS_ENDPOINT,
    poi_endpoint: str | None = None,
    timeout: float = 300.0,
    retries: int = 3,
    backoff_seconds: float = 2.0,
    user_agent: str = DEFAULT_USER_AGENT,
    relation_id: int = UJBUDA_RELATION_ID,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Explicitly download, build, and atomically save the fixed graph."""

    common_options = {
        "endpoint": endpoint,
        "timeout": timeout,
        "retries": retries,
        "backoff_seconds": backoff_seconds,
        "user_agent": user_agent,
    }
    report = progress or (lambda _message: None)
    report("1/3: úthálózat")
    roads_payload = fetch_overpass_json(
        roads_overpass_query(relation_id), **common_options
    )
    report("2/3: kanyarodási korlátozások")
    restrictions_payload = fetch_overpass_json(
        restrictions_overpass_query(relation_id), **common_options
    )
    report("3/3: helyszínek és megállók")
    poi_options = dict(common_options)
    poi_options["endpoint"] = poi_endpoint or endpoint
    poi_payload = fetch_overpass_json(
        pois_overpass_query(relation_id), **poi_options
    )
    report("Gráf építése és csupaszítása")
    network = build_network(
        roads_payload,
        restrictions_payload,
        poi_payload,
        relation_id=relation_id,
        source_endpoint=endpoint,
    )
    if poi_endpoint and poi_endpoint != endpoint:
        network["meta"]["poiSourceEndpoint"] = poi_endpoint
    write_network_gzip(network, output_path)
    report("Adatcsomag elmentve")
    return network


def write_network_gzip(
    network: Mapping[str, Any], output_path: str | os.PathLike[str]
) -> None:
    """Write compact UTF-8 JSON in a reproducible gzip container atomically."""

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=f".{target.name}.", suffix=".tmp", dir=target.parent,
            delete=False,
        ) as raw_file:
            temporary_path = Path(raw_file.name)
            with gzip.GzipFile(
                filename="", fileobj=raw_file, mode="wb", mtime=0
            ) as compressed:
                with io.TextIOWrapper(compressed, encoding="utf-8") as text_file:
                    json.dump(
                        network,
                        text_file,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
        os.replace(temporary_path, target)
    except BaseException:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def load_network_gzip(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Read a graph written by :func:`write_network_gzip`."""

    with gzip.open(path, mode="rt", encoding="utf-8") as input_file:
        payload = json.load(input_file)
    if not isinstance(payload, dict):
        raise OSMNetworkError("A hálózati fájl gyökéreleme nem JSON-objektum.")
    return payload


def _elements(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(payload, Mapping):
        raise OSMNetworkError("Az Overpass-válasz nem JSON-objektum.")
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise OSMNetworkError("Az Overpass-válaszból hiányzik az elements lista.")
    if not all(isinstance(element, dict) for element in elements):
        raise OSMNetworkError("Az Overpass elements lista hibás elemet tartalmaz.")
    return elements


def _integer_id(element: Mapping[str, Any], label: str) -> int:
    value = element.get("id")
    if isinstance(value, bool):
        raise OSMNetworkError(f"Hibás {label} azonosító: {value!r}")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise OSMNetworkError(f"Hibás {label} azonosító: {value!r}") from exc


def _node_id_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    result: list[int] = []
    for node_id in value:
        if isinstance(node_id, bool):
            continue
        try:
            result.append(int(node_id))
        except (TypeError, ValueError):
            continue
    return result


def _collect_nodes(elements: Iterable[Mapping[str, Any]]) -> dict[int, dict[str, Any]]:
    nodes: dict[int, dict[str, Any]] = {}
    for element in elements:
        if element.get("type") != "node":
            continue
        try:
            node_id = _integer_id(element, "node")
            latitude = float(element["lat"])
            longitude = float(element["lon"])
        except (KeyError, TypeError, ValueError, OSMNetworkError):
            continue
        existing = nodes.get(node_id, {})
        combined = dict(existing)
        combined.update(element)
        combined["id"] = node_id
        combined["lat"] = latitude
        combined["lon"] = longitude
        combined_tags = _string_tags(existing.get("tags"))
        combined_tags.update(_string_tags(element.get("tags")))
        if combined_tags:
            combined["tags"] = combined_tags
        nodes[node_id] = combined
    return nodes


def _string_tags(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): str(item)
        for key, item in value.items()
        if item is not None
    }


def _is_area(tags: Mapping[str, str]) -> bool:
    return tags.get("area", "").lower() in {"yes", "1", "true"}


_CAR_HIGHWAYS = {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
    "track",
}
_PEDESTRIAN_HIGHWAYS = {
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
    "track",
    "pedestrian",
    "footway",
    "path",
    "steps",
    "corridor",
    "bridleway",
    "platform",
}
_DENIED_ACCESS = {"no", "private", "use_sidepath"}


def _allowed_modes(tags: Mapping[str, str], direction: str) -> list[str]:
    modes: list[str] = []
    if _mode_allowed(tags, "car", direction):
        modes.append("car")
    if _mode_allowed(tags, "pedestrian", direction):
        modes.append("pedestrian")
    return modes


def _mode_allowed(tags: Mapping[str, str], mode: str, direction: str) -> bool:
    highway = tags.get("highway", "").lower()
    if not highway or highway in {"construction", "proposed", "raceway"}:
        return False

    if mode == "car":
        default_allowed = highway in _CAR_HIGHWAYS
        explicit_keys = (
            f"motorcar:{direction}",
            f"motor_vehicle:{direction}",
            f"vehicle:{direction}",
            "motorcar",
            "motor_vehicle",
            "vehicle",
        )
    else:
        default_allowed = highway in _PEDESTRIAN_HIGHWAYS
        explicit_keys = (f"foot:{direction}", "foot")

    explicit_decision = _first_access_value(tags, explicit_keys)
    generic_decision = _first_access_value(
        tags, (f"access:{direction}", "access")
    )
    if explicit_decision is not None:
        allowed = explicit_decision not in _DENIED_ACCESS
    elif default_allowed:
        allowed = generic_decision not in _DENIED_ACCESS
    else:
        # A generic access=yes must not turn a footway into a road, or a
        # motorway into a footpath.  Promotion from a mode's non-default road
        # class requires a mode-specific OSM tag.
        allowed = False
    if not allowed:
        return False

    one_way = _oneway_direction(tags, mode)
    return one_way == "both" or one_way == direction


def _first_access_value(
    tags: Mapping[str, str], keys: Iterable[str]
) -> str | None:
    for key in keys:
        if key in tags:
            return tags[key].strip().lower()
    return None


def _oneway_direction(tags: Mapping[str, str], mode: str) -> str:
    if mode == "pedestrian":
        raw = tags.get("oneway:foot")
        if raw is None:
            return "both"
    else:
        raw = tags.get("oneway:motorcar") or tags.get("oneway:motor_vehicle")
        if raw is None:
            raw = tags.get("oneway")
        if raw is None and tags.get("junction", "").lower() == "roundabout":
            return "forward"

    normalized = (raw or "").strip().lower()
    if normalized in {"yes", "1", "true"}:
        return "forward"
    if normalized in {"-1", "reverse"}:
        return "backward"
    return "both"


def _lane_data(tags: Mapping[str, str]) -> dict[str, int]:
    total = _parse_lane_count(tags.get("lanes"))
    forward = _parse_lane_count(tags.get("lanes:forward"))
    backward = _parse_lane_count(tags.get("lanes:backward"))
    one_way = _oneway_direction(tags, "car")

    if total is None and forward is not None and backward is not None:
        total = forward + backward
    elif total is None:
        total = max(forward or 0, backward or 0) or (1 if one_way != "both" else 2)

    if forward is None and backward is not None and one_way == "both":
        forward = max(1, total - backward)
    if backward is None and forward is not None and one_way == "both":
        backward = max(1, total - forward)

    if one_way == "forward":
        forward = forward if forward is not None else total
        backward = backward if backward is not None else 0
    elif one_way == "backward":
        forward = forward if forward is not None else 0
        backward = backward if backward is not None else total
    else:
        if total == 1:
            forward = forward if forward is not None else 1
            backward = backward if backward is not None else 1
        else:
            backward = backward if backward is not None else max(1, total // 2)
            forward = forward if forward is not None else max(1, total - backward)

    return {"total": total, "forward": forward, "backward": backward}


def _parse_lane_count(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        number = float(value.strip())
    except ValueError:
        return None
    if not number.is_integer() or number < 0:
        return None
    return int(number)


def _relevant_way_tags(tags: Mapping[str, str]) -> dict[str, str]:
    exact = {
        "access",
        "area",
        "foot",
        "highway",
        "junction",
        "lanes",
        "lanes:backward",
        "lanes:forward",
        "maxspeed",
        "maxspeed:backward",
        "maxspeed:forward",
        "motor_vehicle",
        "motorcar",
        "name",
        "oneway",
        "oneway:foot",
        "oneway:motor_vehicle",
        "oneway:motorcar",
        "vehicle",
    }
    prefixes = ("turn:lanes", "change:lanes")
    return {
        key: tags[key]
        for key in sorted(tags)
        if key in exact or key.startswith(prefixes)
    }


def _make_edge(
    *,
    segment: Mapping[str, Any],
    tags: Mapping[str, str],
    direction: str,
    from_id: int,
    to_id: int,
    modes: list[str],
    lanes: int,
    length_meters: float,
) -> dict[str, Any]:
    lane_count = max(1, lanes)
    turn_lanes_raw = _directional_tag(tags, "turn:lanes", direction)
    maxspeed_raw = _directional_tag(
        tags, "maxspeed", direction, generic_applies_both=True
    )
    return {
        "id": f"{segment['id']}:{'f' if direction == 'forward' else 'b'}",
        "segmentId": segment["id"],
        "wayId": segment["wayId"],
        "from": from_id,
        "to": to_id,
        "highway": segment["highway"],
        "direction": direction,
        "modes": modes,
        "lanes": lane_count,
        "totalLanes": segment["totalLanes"],
        "turnLanes": _parse_turn_lanes(turn_lanes_raw),
        "turnLanesTag": turn_lanes_raw,
        "maxSpeedKph": _maxspeed_kph(maxspeed_raw, str(segment["highway"])),
        "maxspeedTag": maxspeed_raw,
        "lengthMeters": round(length_meters, 3),
    }


def _directional_tag(
    tags: Mapping[str, str],
    base_key: str,
    direction: str,
    *,
    generic_applies_both: bool = False,
) -> str | None:
    directional = tags.get(f"{base_key}:{direction}")
    if directional is not None:
        return directional
    generic = tags.get(base_key)
    if generic is None:
        return None
    if generic_applies_both:
        return generic
    one_way = _oneway_direction(tags, "car")
    if one_way == direction or (one_way == "both" and direction == "forward"):
        return generic
    return None


def _parse_turn_lanes(value: str | None) -> list[list[str]]:
    if value is None:
        return []
    return [
        [option.strip() for option in lane.split(";") if option.strip()]
        for lane in value.split("|")
    ]


_SPEED_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph|km/?h|kph)?\s*$", re.I)
_SYMBOLIC_SPEEDS = {
    "hu:urban": 50.0,
    "hu:rural": 90.0,
    "hu:trunk": 110.0,
    "hu:motorway": 130.0,
    "hu:living_street": 20.0,
    "walk": 5.0,
}
_DEFAULT_SPEEDS = {
    "motorway": 130.0,
    "motorway_link": 60.0,
    "trunk": 110.0,
    "trunk_link": 60.0,
    "primary": 50.0,
    "primary_link": 50.0,
    "secondary": 50.0,
    "secondary_link": 50.0,
    "tertiary": 50.0,
    "tertiary_link": 50.0,
    "unclassified": 50.0,
    "residential": 50.0,
    "living_street": 20.0,
    "service": 30.0,
    "road": 50.0,
    "track": 20.0,
}


def _maxspeed_kph(value: str | None, highway: str) -> float:
    if value:
        first_value = value.split(";")[0].strip()
        symbolic = _SYMBOLIC_SPEEDS.get(first_value.lower())
        if symbolic is not None:
            return symbolic
        match = _SPEED_PATTERN.fullmatch(first_value)
        if match:
            speed = float(match.group(1))
            if (match.group(2) or "").lower() == "mph":
                speed *= 1.609344
            return round(speed, 3)
    return _DEFAULT_SPEEDS.get(highway.lower(), 5.0)


_MODE_ORDER = ("car", "pedestrian")


def _prune_disconnected_network(
    segments: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    restrictions: list[dict[str, Any]],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    set[int],
    dict[str, Any],
]:
    """Keep only the largest weak component of every transport mode."""

    original_node_ids = {
        int(node_id)
        for segment in segments
        for node_id in (segment["from"], segment["to"])
    }
    kept_edge_indexes: dict[str, set[int]] = {}
    mode_stats: dict[str, Any] = {}

    for mode in _MODE_ORDER:
        adjacency: dict[int, list[tuple[int, int]]] = {}
        mode_edge_indexes: set[int] = set()
        for edge_index, edge in enumerate(edges):
            if mode not in edge.get("modes", []):
                continue
            from_id = int(edge["from"])
            to_id = int(edge["to"])
            mode_edge_indexes.add(edge_index)
            adjacency.setdefault(from_id, []).append((to_id, edge_index))
            adjacency.setdefault(to_id, []).append((from_id, edge_index))

        components: list[tuple[set[int], set[int]]] = []
        unseen = set(adjacency)
        while unseen:
            start = min(unseen)
            stack = [start]
            component_nodes: set[int] = set()
            component_edges: set[int] = set()
            while stack:
                node_id = stack.pop()
                if node_id in component_nodes:
                    continue
                component_nodes.add(node_id)
                unseen.discard(node_id)
                for neighbor_id, edge_index in adjacency.get(node_id, []):
                    component_edges.add(edge_index)
                    if neighbor_id not in component_nodes:
                        stack.append(neighbor_id)
            components.append((component_nodes, component_edges))

        components.sort(
            key=lambda component: (
                -len(component[0]),
                -len(component[1]),
                min(component[0]),
            )
        )
        retained_nodes, retained_edges = (
            components[0] if components else (set(), set())
        )
        kept_edge_indexes[mode] = set(retained_edges)
        all_mode_nodes = set(adjacency)
        mode_stats[mode] = {
            "componentsBefore": len(components),
            "removedComponents": max(0, len(components) - 1),
            "componentNodeSizes": [len(component[0]) for component in components],
            "componentEdgeSizes": [len(component[1]) for component in components],
            "modeEdgesBefore": len(mode_edge_indexes),
            "modeEdgesAfter": len(retained_edges),
            "removedModeEdges": len(mode_edge_indexes) - len(retained_edges),
            "modeNodesBefore": len(all_mode_nodes),
            "modeNodesAfter": len(retained_nodes),
            "removedModeNodes": len(all_mode_nodes - retained_nodes),
        }

    pruned_edges: list[dict[str, Any]] = []
    for edge_index, edge in enumerate(edges):
        retained_modes = [
            mode
            for mode in _MODE_ORDER
            if mode in edge.get("modes", [])
            and edge_index in kept_edge_indexes.get(mode, set())
        ]
        if not retained_modes:
            continue
        retained_edge = dict(edge)
        retained_edge["modes"] = retained_modes
        pruned_edges.append(retained_edge)

    retained_segment_ids = {str(edge["segmentId"]) for edge in pruned_edges}
    segment_modes: dict[str, set[str]] = {}
    for edge in pruned_edges:
        segment_modes.setdefault(str(edge["segmentId"]), set()).update(edge["modes"])

    pruned_segments: list[dict[str, Any]] = []
    for segment in segments:
        segment_id = str(segment["id"])
        if segment_id not in retained_segment_ids:
            continue
        retained_segment = dict(segment)
        retained_segment["modes"] = [
            mode for mode in _MODE_ORDER if mode in segment_modes[segment_id]
        ]
        pruned_segments.append(retained_segment)

    retained_node_ids = {
        int(node_id)
        for edge in pruned_edges
        for node_id in (edge["from"], edge["to"])
    }
    retained_way_ids = {int(segment["wayId"]) for segment in pruned_segments}
    pruned_restrictions = [
        restriction
        for restriction in restrictions
        if _restriction_is_valid(
            restriction,
            retained_way_ids=retained_way_ids,
            retained_node_ids=retained_node_ids,
        )
    ]

    before = {
        "nodes": len(original_node_ids),
        "segments": len(segments),
        "edges": len(edges),
        "restrictions": len(restrictions),
    }
    after = {
        "nodes": len(retained_node_ids),
        "segments": len(pruned_segments),
        "edges": len(pruned_edges),
        "restrictions": len(pruned_restrictions),
    }
    pruning = {
        "strategy": "largestWeakComponentPerMode",
        "before": before,
        "after": after,
        "removed": {key: before[key] - after[key] for key in before},
        "modes": mode_stats,
    }
    return (
        pruned_segments,
        pruned_edges,
        pruned_restrictions,
        retained_node_ids,
        pruning,
    )


def _restriction_is_valid(
    restriction: Mapping[str, Any],
    *,
    retained_way_ids: set[int],
    retained_node_ids: set[int],
) -> bool:
    from_ways = {int(way_id) for way_id in restriction.get("fromWays", [])}
    to_ways = {int(way_id) for way_id in restriction.get("toWays", [])}
    via_ways = {int(way_id) for way_id in restriction.get("viaWays", [])}
    via_nodes = {int(node_id) for node_id in restriction.get("viaNodes", [])}
    if not from_ways or not to_ways or not (via_ways or via_nodes):
        return False
    return (
        from_ways <= retained_way_ids
        and to_ways <= retained_way_ids
        and via_ways <= retained_way_ids
        and via_nodes <= retained_node_ids
    )


_POI_CATEGORIES = (
    "parking",
    "transit",
    "shopping",
    "food",
    "health",
    "education",
    "leisure",
    "service",
    "other",
)
_POI_WEIGHTS = {
    "parking": 3,
    "transit": 4,
    "shopping": 3,
    "food": 3,
    "health": 2,
    "education": 2,
    "leisure": 2,
    "service": 2,
    "other": 1,
}
_FOOD_AMENITIES = {
    "bar",
    "biergarten",
    "cafe",
    "fast_food",
    "food_court",
    "ice_cream",
    "pub",
    "restaurant",
}
_HEALTH_AMENITIES = {
    "clinic",
    "dentist",
    "doctors",
    "hospital",
    "nursing_home",
    "pharmacy",
    "social_facility",
    "veterinary",
}
_EDUCATION_AMENITIES = {
    "childcare",
    "college",
    "driving_school",
    "kindergarten",
    "language_school",
    "library",
    "music_school",
    "school",
    "training",
    "university",
}
_LEISURE_AMENITIES = {
    "arts_centre",
    "cinema",
    "community_centre",
    "events_venue",
    "nightclub",
    "social_centre",
    "theatre",
}
_SERVICE_AMENITIES = {
    "atm",
    "bank",
    "bureau_de_change",
    "car_rental",
    "car_sharing",
    "car_wash",
    "charging_station",
    "courthouse",
    "fuel",
    "police",
    "post_office",
    "public_building",
    "townhall",
}
_SERVICE_SHOPS = {
    "beauty",
    "bicycle_repair",
    "car_repair",
    "dry_cleaning",
    "funeral_directors",
    "hairdresser",
    "laundry",
    "locksmith",
    "massage",
    "optician",
    "pawnbroker",
    "pet_grooming",
    "tailor",
    "tattoo",
    "travel_agency",
}


def _poi_records(elements: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    records_by_id: dict[str, dict[str, Any]] = {}
    for element in elements:
        osm_type = str(element.get("type", ""))
        if osm_type not in {"node", "way", "relation"}:
            continue
        try:
            osm_id = _integer_id(element, f"{osm_type} POI")
        except OSMNetworkError:
            continue
        center = _poi_center(element)
        if center is None:
            continue
        tags = dict(sorted(_string_tags(element.get("tags")).items()))
        if not tags:
            continue
        category = _poi_category(tags)
        record_id = f"{osm_type}/{osm_id}"
        records_by_id[record_id] = {
            "id": record_id,
            "osmType": osm_type,
            "osmId": osm_id,
            "lat": center[0],
            "lng": center[1],
            "name": (
                tags.get("name:hu")
                or tags.get("name")
                or tags.get("brand")
                or tags.get("operator")
                or ""
            ),
            "category": category,
            "subtype": _poi_subtype(tags),
            "tags": tags,
            "tripModes": _poi_trip_modes(tags, category),
            "weight": _POI_WEIGHTS[category],
        }
    osm_type_order = {"node": 0, "way": 1, "relation": 2}
    return sorted(
        records_by_id.values(),
        key=lambda record: (osm_type_order[record["osmType"]], record["osmId"]),
    )


def _poi_center(element: Mapping[str, Any]) -> tuple[float, float] | None:
    coordinate_source: Mapping[str, Any] = element
    if element.get("type") != "node":
        center = element.get("center")
        if not isinstance(center, Mapping):
            return None
        coordinate_source = center
    try:
        latitude = float(coordinate_source["lat"])
        longitude = float(coordinate_source["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if (
        not math.isfinite(latitude)
        or not math.isfinite(longitude)
        or not -90 <= latitude <= 90
        or not -180 <= longitude <= 180
    ):
        return None
    return latitude, longitude


def _poi_category(tags: Mapping[str, str]) -> str:
    amenity = tags.get("amenity", "").lower()
    shop = tags.get("shop", "").lower()
    if amenity in {"parking", "parking_entrance", "parking_space", "bicycle_parking"}:
        return "parking"
    if (
        tags.get("public_transport")
        or tags.get("highway", "").lower() == "bus_stop"
        or tags.get("railway", "").lower()
        in {"tram_stop", "station", "halt", "subway_entrance"}
    ):
        return "transit"
    if amenity in _FOOD_AMENITIES:
        return "food"
    if tags.get("healthcare") or amenity in _HEALTH_AMENITIES:
        return "health"
    if amenity in _EDUCATION_AMENITIES:
        return "education"
    if shop in _SERVICE_SHOPS or tags.get("office") or tags.get("craft"):
        return "service"
    if shop or amenity == "marketplace":
        return "shopping"
    if tags.get("tourism") or tags.get("leisure") or amenity in _LEISURE_AMENITIES:
        return "leisure"
    if amenity in _SERVICE_AMENITIES:
        return "service"
    return "other"


def _poi_subtype(tags: Mapping[str, str]) -> str:
    for key in (
        "amenity",
        "shop",
        "tourism",
        "leisure",
        "office",
        "craft",
        "healthcare",
        "public_transport",
        "highway",
        "railway",
    ):
        value = tags.get(key)
        if value:
            return value
    return "unknown"


def _poi_trip_modes(tags: Mapping[str, str], category: str) -> list[str]:
    generic_access = _first_access_value(tags, ("access",))
    car_access = _first_access_value(tags, ("motorcar", "motor_vehicle", "vehicle"))
    foot_access = _first_access_value(tags, ("foot",))

    car_allowed = category != "transit"
    pedestrian_allowed = True
    if car_access is not None:
        car_allowed = car_allowed and car_access not in _DENIED_ACCESS
    elif generic_access in _DENIED_ACCESS:
        car_allowed = False
    if foot_access is not None:
        pedestrian_allowed = foot_access not in _DENIED_ACCESS
    elif generic_access in _DENIED_ACCESS:
        pedestrian_allowed = False

    modes: list[str] = []
    if car_allowed:
        modes.append("car")
    if pedestrian_allowed:
        modes.append("pedestrian")
    return modes


def _category_counts(pois: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    counts = {category: 0 for category in _POI_CATEGORIES}
    for poi in pois:
        category = str(poi.get("category", "other"))
        counts[category if category in counts else "other"] += 1
    return counts


def _node_record(node: Mapping[str, Any]) -> dict[str, Any]:
    tags = _string_tags(node.get("tags"))
    crossing_value = tags.get("crossing", "").lower()
    crossing = tags.get("highway") == "crossing" or bool(
        crossing_value and crossing_value not in {"no", "none"}
    )
    return {
        "id": _integer_id(node, "node"),
        "lat": float(node["lat"]),
        "lng": float(node["lon"]),
        "trafficSignal": tags.get("highway") == "traffic_signals",
        "crossing": crossing,
    }


def _restriction_records(elements: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for element in elements:
        if element.get("type") != "relation":
            continue
        tags = _string_tags(element.get("tags"))
        if not tags.get("type", "").startswith("restriction"):
            continue
        members = element.get("members")
        if not isinstance(members, list):
            members = []
        from_ways = _member_refs(members, "way", "from")
        to_ways = _member_refs(members, "way", "to")
        via_nodes = _member_refs(members, "node", "via")
        via_ways = _member_refs(members, "way", "via")
        restriction_key = "restriction"
        if restriction_key not in tags:
            alternatives = sorted(
                key
                for key in tags
                if key.startswith("restriction:") and not key.endswith(":conditional")
            )
            if alternatives:
                restriction_key = alternatives[0]
        records.append(
            {
                "id": _integer_id(element, "restriction relation"),
                "restriction": tags.get(restriction_key, ""),
                "fromWays": from_ways,
                "toWays": to_ways,
                "viaNodes": via_nodes,
                "viaWays": via_ways,
                "except": _split_except(tags.get("except")),
            }
        )
    return sorted(records, key=lambda record: record["id"])


def _member_refs(members: list[Any], member_type: str, role: str) -> list[int]:
    references: list[int] = []
    for member in members:
        if not isinstance(member, Mapping):
            continue
        if member.get("type") != member_type or member.get("role") != role:
            continue
        reference = member.get("ref")
        if isinstance(reference, bool):
            continue
        try:
            references.append(int(reference))
        except (TypeError, ValueError):
            continue
    return references


def _split_except(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in re.split(r"[;,]", value) if item.strip()]


def _find_bounds(
    supplementary_elements: Iterable[Mapping[str, Any]],
    nodes: Mapping[int, Mapping[str, Any]],
    *,
    relation_id: int,
    fallback_node_ids: set[int],
) -> dict[str, float]:
    elements = list(supplementary_elements)
    for element in elements:
        if element.get("type") != "relation":
            continue
        try:
            if _integer_id(element, "relation") != relation_id:
                continue
        except OSMNetworkError:
            continue
        parsed = _parse_bounds(element.get("bounds"))
        if parsed is not None:
            return parsed

    supplementary_node_ids = {
        _integer_id(element, "node")
        for element in elements
        if element.get("type") == "node" and element.get("id") is not None
    }
    candidate_ids = supplementary_node_ids or fallback_node_ids
    coordinates = [nodes[node_id] for node_id in candidate_ids if node_id in nodes]
    if not coordinates:
        raise OSMNetworkError("Nem állapítható meg a XI. kerület térképhatára.")
    return {
        "south": min(float(node["lat"]) for node in coordinates),
        "west": min(float(node["lon"]) for node in coordinates),
        "north": max(float(node["lat"]) for node in coordinates),
        "east": max(float(node["lon"]) for node in coordinates),
    }


def _parse_bounds(value: Any) -> dict[str, float] | None:
    if not isinstance(value, Mapping):
        return None
    try:
        south = float(value["minlat"])
        west = float(value["minlon"])
        north = float(value["maxlat"])
        east = float(value["maxlon"])
    except (KeyError, TypeError, ValueError):
        return None
    if south > north or west > east:
        return None
    return {"south": south, "west": west, "north": north, "east": east}


def _osm_timestamp(*payloads: Mapping[str, Any]) -> str | None:
    timestamps: list[str] = []
    for payload in payloads:
        osm3s = payload.get("osm3s")
        if isinstance(osm3s, Mapping):
            timestamp = osm3s.get("timestamp_osm_base")
            if timestamp:
                timestamps.append(str(timestamp))
    return max(timestamps) if timestamps else None


def _network_id(timestamp: str) -> str:
    compact_timestamp = re.sub(r"[^0-9A-Za-z]+", "", timestamp)
    return f"ujbuda-osm-{compact_timestamp or 'unknown'}"


def _retry_after_seconds(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _haversine_meters(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    earth_radius_meters = 6_371_000.0
    latitude_a_rad = math.radians(latitude_a)
    latitude_b_rad = math.radians(latitude_b)
    latitude_delta = math.radians(latitude_b - latitude_a)
    longitude_delta = math.radians(longitude_b - longitude_a)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude_a_rad)
        * math.cos(latitude_b_rad)
        * math.sin(longitude_delta / 2) ** 2
    )
    return earth_radius_meters * 2 * math.atan2(
        math.sqrt(haversine), math.sqrt(1 - haversine)
    )


__all__ = [
    "DEFAULT_OVERPASS_ENDPOINT",
    "DEFAULT_USER_AGENT",
    "OSMNetworkError",
    "UJBUDA_RELATION_ID",
    "build_network",
    "download_ujbuda_network",
    "fetch_overpass_json",
    "load_network_gzip",
    "pois_overpass_query",
    "restrictions_overpass_query",
    "roads_overpass_query",
    "write_network_gzip",
]
