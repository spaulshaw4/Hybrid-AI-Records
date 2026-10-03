"""Report what the mix ledger says the selection weights should be.

Reads the ledger, fits the six components against the picks that landed well,
and prints the proposed weights beside the ones in force. Prints only — editing
``SCORE_WEIGHTS_MUSICAL`` stays a deliberate act, because a fit that disagrees
with the current weights is a question, not an instruction.

    python scripts/fit_selection_weights.py
    python scripts/fit_selection_weights.py --status   # evidence count only
"""
from __future__ import annotations

import argparse
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine import mix_history  # noqa: E402
from engine.stem_selector import SCORE_WEIGHTS_MUSICAL  # noqa: E402
from engine.weight_fitter import (  # noqa: E402
    COMPONENTS,
    MIN_COMPARISONS,
    MIN_SESSIONS,
    InsufficientEvidence,
    build_comparisons,
    fit_selection_weights,
    verdict_labels,
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=None, help="ledger path (defaults to the live one)")
    ap.add_argument("--status", action="store_true", help="report evidence only, do not fit")
    ap.add_argument("--holdout", type=float, default=0.25)
    args = ap.parse_args()

    conn = mix_history.open_ledger(args.db)
    try:
        decisions = [
            dict(
                zip(
                    (
                        "session_id", "role", "chosen", "score",
                        "fit_key", "fit_chord", "fit_bpm",
                        "fit_centroid", "fit_level", "fit_groove",
                    ),
                    row,
                )
            )
            for row in conn.execute(
                "SELECT session_id, role, chosen, score, fit_key, fit_chord, fit_bpm, "
                "fit_centroid, fit_level, fit_groove FROM mix_decisions"
            )
        ]
        verdicts = [
            {"session_id": r[0], "label": r[1]}
            for r in conn.execute("SELECT session_id, label FROM mix_verdicts")
        ]
        summary = mix_history.summary(conn)
    finally:
        conn.close()

    labels = verdict_labels(verdicts)
    diffs, _ = build_comparisons(decisions, labels)
    print(
        f"ledger: {summary['sessions']} sessions, {summary['decisions']} decisions, "
        f"{summary['chosen']} staged, {summary['verdicts']} verdicts"
    )
    print(
        f"usable: {diffs.shape[0]} comparisons across {len(labels)} labelled sessions "
        f"(need >= {MIN_COMPARISONS} and >= {MIN_SESSIONS})"
    )
    if args.status:
        return 0

    try:
        result = fit_selection_weights(decisions, labels, holdout=args.holdout)
    except InsufficientEvidence as exc:
        print(f"\nnot fitting: {exc}")
        return 0

    print(
        f"\ntrain accuracy {result['train_accuracy']:.3f} | "
        f"holdout {result['holdout_accuracy']:.3f}"
    )
    print(f"\n{'component':<10} {'in force':>9} {'proposed':>9} {'delta':>8}")
    for name in COMPONENTS:
        current = float(SCORE_WEIGHTS_MUSICAL.get(name, 0.0))
        proposed = float(result["weights"].get(name, 0.0))
        print(f"{name:<10} {current:>9.2f} {proposed:>9.2f} {proposed - current:>+8.2f}")
    if result["holdout_accuracy"] < 0.55:
        print(
            "\nHoldout barely beats a coin flip — the ledger does not yet separate "
            "good picks from bad. Keep the weights in force."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
