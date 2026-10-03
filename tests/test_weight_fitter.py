"""The fitter must recover a known weighting and refuse thin evidence."""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.weight_fitter import (  # noqa: E402
    COMPONENTS,
    MIN_COMPARISONS,
    MIN_SESSIONS,
    InsufficientEvidence,
    build_comparisons,
    fit_selection_weights,
    normalise,
    ranking_accuracy,
    verdict_labels,
)


def _synth(
    truth: dict[str, float],
    *,
    sessions: int = 12,
    per_role: int = 24,
    label: float = 1.0,
    seed: int = 7,
):
    """Ledger rows where the staged stem genuinely won on `truth`'s weighting."""
    rng = np.random.default_rng(seed)
    decisions: list[dict] = []
    labels: dict[str, float] = {}
    vec = np.array([truth.get(c, 0.0) for c in COMPONENTS], dtype=np.float64)
    for s in range(sessions):
        session = f"ht_{s:04d}"
        labels[session] = label
        for role in ("rhythm", "harmonic"):
            cands = rng.random((per_role, len(COMPONENTS)))
            scores = cands @ vec
            winner = int(np.argmax(scores))
            for i, row in enumerate(cands):
                decisions.append(
                    {
                        "session_id": session,
                        "role": role,
                        "chosen": 1 if i == winner else 0,
                        **{f"fit_{c}": float(row[j]) for j, c in enumerate(COMPONENTS)},
                    }
                )
    return decisions, labels


class TestRecovery(unittest.TestCase):
    def test_recovers_the_dominant_component(self):
        """If chord drove every pick, the fit must say chord dominates."""
        truth = {"chord": 1.0, "key": 0.05, "bpm": 0.05, "centroid": 0.05,
                 "level": 0.05, "groove": 0.05}
        decisions, labels = _synth(truth)
        result = fit_selection_weights(decisions, labels)
        weights = result["weights"]
        self.assertEqual(max(weights, key=lambda k: weights[k]), "chord")

    def test_recovers_a_different_dominant_component(self):
        """Guards against a fit that always answers 'chord'."""
        truth = {"bpm": 1.0, "key": 0.05, "chord": 0.05, "centroid": 0.05,
                 "level": 0.05, "groove": 0.05}
        decisions, labels = _synth(truth, seed=11)
        weights = fit_selection_weights(decisions, labels)["weights"]
        self.assertEqual(max(weights, key=lambda k: weights[k]), "bpm")

    def test_holdout_beats_chance_on_learnable_data(self):
        truth = {"chord": 1.0, "groove": 0.6, "key": 0.1, "bpm": 0.1,
                 "centroid": 0.1, "level": 0.1}
        decisions, labels = _synth(truth, seed=3)
        result = fit_selection_weights(decisions, labels)
        self.assertGreater(result["holdout_accuracy"], 0.6)

    def test_weights_sum_to_one(self):
        truth = {c: 1.0 for c in COMPONENTS}
        decisions, labels = _synth(truth, seed=5)
        weights = fit_selection_weights(decisions, labels)["weights"]
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=2)
        self.assertEqual(set(weights), set(COMPONENTS))


class TestEvidenceGuard(unittest.TestCase):
    def test_refuses_too_few_sessions(self):
        decisions, labels = _synth({"chord": 1.0}, sessions=2, per_role=40)
        with self.assertRaises(InsufficientEvidence):
            fit_selection_weights(decisions, labels)

    def test_refuses_too_few_comparisons(self):
        decisions, labels = _synth({"chord": 1.0}, sessions=MIN_SESSIONS + 2, per_role=2)
        with self.assertRaises(InsufficientEvidence):
            fit_selection_weights(decisions, labels)

    def test_error_reports_what_is_missing(self):
        decisions, labels = _synth({"chord": 1.0}, sessions=2, per_role=3)
        with self.assertRaises(InsufficientEvidence) as ctx:
            fit_selection_weights(decisions, labels)
        self.assertLess(ctx.exception.sessions, MIN_SESSIONS)
        self.assertIn("not enough evidence", str(ctx.exception))

    def test_an_empty_ledger_does_not_crash(self):
        with self.assertRaises(InsufficientEvidence):
            fit_selection_weights([], {})


class TestComparisons(unittest.TestCase):
    def test_unlabelled_sessions_are_skipped(self):
        decisions, _ = _synth({"chord": 1.0}, sessions=3)
        diffs, _ = build_comparisons(decisions, {})
        self.assertEqual(diffs.shape[0], 0)

    def test_neutral_labels_carry_no_direction(self):
        decisions, labels = _synth({"chord": 1.0}, sessions=3)
        diffs, _ = build_comparisons(decisions, {k: 0.0 for k in labels})
        self.assertEqual(diffs.shape[0], 0)

    def test_a_skipped_track_inverts_its_comparisons(self):
        """A rejection is information, not something to discard."""
        decisions, labels = _synth({"chord": 1.0}, sessions=3)
        _, pos = build_comparisons(decisions, labels)
        _, neg = build_comparisons(decisions, {k: -1.0 for k in labels})
        self.assertTrue((pos > 0).all())
        self.assertTrue((neg < 0).all())

    def test_groups_without_a_winner_are_dropped(self):
        rows = [
            {"session_id": "s", "role": "r", "chosen": 0, "fit_chord": 0.5},
            {"session_id": "s", "role": "r", "chosen": 0, "fit_chord": 0.9},
        ]
        diffs, _ = build_comparisons(rows, {"s": 1.0})
        self.assertEqual(diffs.shape[0], 0)

    def test_missing_fits_read_as_neutral(self):
        rows = [
            {"session_id": "s", "role": "r", "chosen": 1},
            {"session_id": "s", "role": "r", "chosen": 0, "fit_chord": None},
        ]
        diffs, _ = build_comparisons(rows, {"s": 1.0})
        self.assertEqual(diffs.shape, (1, len(COMPONENTS)))
        np.testing.assert_allclose(diffs[0], np.zeros(len(COMPONENTS)))


class TestHelpers(unittest.TestCase):
    def test_normalise_floors_negatives_instead_of_zeroing_them(self):
        weights = normalise(np.array([-5.0, 1.0, 1.0, 1.0, 1.0, 1.0]))
        self.assertGreater(weights["key"], 0.0)
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=2)

    def test_verdict_labels_average_and_clamp(self):
        labels = verdict_labels(
            [
                {"session_id": "a", "label": 1.0},
                {"session_id": "a", "label": 0.0},
                {"session_id": "b", "label": -5.0},
            ]
        )
        self.assertAlmostEqual(labels["a"], 0.5)
        self.assertEqual(labels["b"], -1.0)

    def test_ranking_accuracy_is_one_on_a_perfect_fit(self):
        diffs = np.array([[1.0, 0, 0, 0, 0, 0], [2.0, 0, 0, 0, 0, 0]])
        weights = np.array([1.0, 1.0])
        coef = np.array([1.0, 0, 0, 0, 0, 0])
        self.assertEqual(ranking_accuracy(diffs, weights, coef), 1.0)

    def test_min_thresholds_exceed_the_parameter_count(self):
        self.assertGreater(MIN_COMPARISONS, len(COMPONENTS) * 10)
        self.assertGreater(MIN_SESSIONS, 1)


if __name__ == "__main__":
    unittest.main()
