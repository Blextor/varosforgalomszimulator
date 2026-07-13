"""Tests for the offline active-route usage analyzer."""

from __future__ import annotations

from types import SimpleNamespace
import unittest

from tools.analyze_route_usage import (
    _gini_coefficient,
    _top_share,
    analyze_mode,
)


def _edge(
    edge_id: str,
    segment_id: str,
    from_node: int,
    to_node: int,
    latitude: float,
    longitude: float,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=edge_id,
        segment_id=segment_id,
        from_node=from_node,
        to_node=to_node,
        way_id=from_node * 100 + to_node,
        start=(latitude, longitude),
        end=(latitude + 0.01, longitude + 0.01),
    )


class FakeNetwork:
    def __init__(self) -> None:
        self.meta = {
            "bounds": {"south": 0.0, "west": 0.0, "north": 1.0, "east": 1.0}
        }
        self.nodes = {}
        edges = (
            _edge("a", "segment-a", 1, 2, 0.10, 0.10),
            _edge("a-reverse", "segment-a", 2, 1, 0.10, 0.10),
            _edge("b", "segment-b", 2, 4, 0.20, 0.20),
            _edge("b-reverse", "segment-b", 4, 2, 0.20, 0.20),
            _edge("c", "segment-c", 4, 3, 0.30, 0.30),
            _edge("c-reverse", "segment-c", 3, 4, 0.30, 0.30),
            _edge("unused", "segment-unused", 5, 6, 0.80, 0.80),
        )
        self.edges_by_mode = {"car": edges}
        self.edges_by_id = {edge.id: edge for edge in edges}
        self.outgoing = {}
        for edge in edges:
            self.outgoing.setdefault((edge.from_node, "car"), []).append(edge)

    @staticmethod
    def extend_way_history(
        history: tuple[int, ...], next_way_id: int
    ) -> tuple[int, ...]:
        return (*history, next_way_id)[-4:]

    def allowed_outgoing(
        self,
        incoming: SimpleNamespace,
        mode: str,
        history: tuple[int, ...],
    ) -> tuple[SimpleNamespace, ...]:
        del history
        return tuple(self.outgoing.get((incoming.to_node, mode), ()))


class RouteUsageAnalyzerTests(unittest.TestCase):
    def test_math_helpers_include_zero_usage_edges(self) -> None:
        self.assertAlmostEqual(_gini_coefficient([0, 0, 1, 3]), 0.625)
        self.assertAlmostEqual(_top_share([0, 0, 1, 3], 0.25), 0.75)
        self.assertEqual(_gini_coefficient([]), 0.0)

    def test_analyze_mode_counts_loops_and_transition_direction(self) -> None:
        network = FakeNetwork()
        origin_a = SimpleNamespace(poi=SimpleNamespace(id="A"), node_id=1)
        origin_b = SimpleNamespace(poi=SimpleNamespace(id="B"), node_id=3)
        simulation = SimpleNamespace(
            network=network,
            route_successors={"car": {"A": (origin_b,), "B": (origin_a,)}},
            route_pois_by_id={"car": {"A": origin_a, "B": origin_b}},
            route_cache={
                ("car", "A", "B"): ("a", "b", "b-reverse", "b", "c"),
                ("car", "B", "A"): ("c-reverse", "b-reverse", "a-reverse"),
            },
        )

        report = analyze_mode(
            network,
            simulation,
            "car",
            rare_threshold=1,
            grid_size=48,
        )

        self.assertEqual(report["routeCount"], 2)
        self.assertEqual(report["networkEdgeCount"], 7)
        self.assertEqual(report["usedEdgeCount"], 6)
        self.assertEqual(report["neverUsedEdgeCount"], 1)
        self.assertEqual(report["repeatedPhysicalSegmentRouteCount"], 1)
        self.assertEqual(report["loopingRouteCount"], 1)
        self.assertEqual(report["originFirstEdgeCompatibleCount"], 2)
        self.assertEqual(report["transitionCandidateCount"], 2)
        self.assertEqual(report["transitionCompatibleCount"], 2)
        self.assertEqual(report["transitionImmediateReverseCount"], 2)
        self.assertGreater(report["routeGridCellCoveragePercent"], 0.0)


if __name__ == "__main__":
    unittest.main()
