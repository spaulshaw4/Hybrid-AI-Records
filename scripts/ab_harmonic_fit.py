"""A/B the picker: does chord-aware scoring choose better-fitting stems?

Both arms score the *same* candidate pool, so the only variable is the scorer.
Arm A is the legacy key/bpm/centroid/level weighting; arm B adds measured
chroma scored against the song's chord progression. The metric is harmonic
fit -- the share of a slice's pitch energy that lands on the progression's
tones -- averaged over the stems each arm would actually stage.

Only slices that have measured chroma are pooled, so the number reflects the
scorer rather than how far the backfill has run.

    python scripts/ab_harmonic_fit.py --genre cyberpunk_darksynth --bpm 120
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.musical_features import (  # noqa: E402
    CONFIDENCE_BYPASS,
    harmonic_fit,
    plan_pitch_weights,
    unpack_floats,
)
from engine.musical_index import musical_db_path  # noqa: E402
from engine.stem_selector import rank_candidates  # noqa: E402

LIVE_INDEX = r"C:\live_web_outputs\db\corpus_index_live.sqlite"


def measured_pool(role_stem: str, limit: int) -> list[dict]:
    """Candidate rows that already have chroma, joined across both DBs."""
    mus = sqlite3.connect(f"file:{musical_db_path()}?mode=ro", uri=True)
    mus.execute("PRAGMA busy_timeout=15000")
    have = {
        str(p): (c, g, conf)
        for p, c, g, conf in mus.execute(
            "SELECT file_path, chroma, onset_grid, chroma_confidence FROM slice_musical "
            "WHERE chroma IS NOT NULL"
        )
    }
    mus.close()
    if not have:
        return []
    live = sqlite3.connect(f"file:{LIVE_INDEX}?mode=ro", uri=True)
    live.execute("PRAGMA busy_timeout=30000")
    rows: list[dict] = []
    for path, fn, stem, key, bpm, rms, cent in live.execute(
        "SELECT file_path, filename, stem_type, detected_key, estimated_bpm, rms_db, "
        "spectral_centroid FROM slice_index WHERE stem_type = ? AND rms_db > -45",
        (role_stem,),
    ):
        hit = have.get(str(path))
        if not hit:
            continue
        rows.append(
            {
                "file_path": path,
                "filename": fn,
                "stem_type": stem,
                "detected_key": key,
                "estimated_bpm": bpm,
                "rms_db": rms,
                "spectral_centroid": cent,
                "chroma": hit[0],
                "onset_grid": hit[1],
                "chroma_confidence": hit[2],
            }
        )
        if len(rows) >= limit:
            break
    live.close()
    return rows


def fits(picks: list[dict], weights: np.ndarray) -> np.ndarray:
    """Raw measured fit per pick -- deliberately unweighted by confidence.

    The metric has to stay independent of the scorer under test, otherwise
    down-weighting a measurement would improve the benchmark by definition.
    """
    return np.array(
        [harmonic_fit(unpack_floats(p.get("chroma"), 12), weights) for p in picks],
        dtype=np.float64,
    )


def mean_fit(picks: list[dict], weights: np.ndarray) -> float:
    if not picks:
        return float("nan")
    return float(np.mean(fits(picks, weights)))


def by_band(picks: list[dict], weights: np.ndarray, threshold: float) -> str:
    """Split the picks into trusted / bypassed measurements and report each."""
    if not picks:
        return "no picks"
    conf = np.array([float(p.get("chroma_confidence") or 0.0) for p in picks])
    f = fits(picks, weights)
    trusted = conf >= threshold
    parts = []
    for label, mask in (("trusted", trusted), ("bypassed", ~trusted)):
        if mask.any():
            parts.append(f"{label} {int(mask.sum())} @ fit {float(f[mask].mean()):.3f}")
        else:
            parts.append(f"{label} 0")
    return "  ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--key", default="A")
    ap.add_argument("--bpm", type=float, default=120.0)
    ap.add_argument("--top", type=int, default=8, help="stems staged per role")
    ap.add_argument("--pool", type=int, default=3000)
    ap.add_argument(
        "--chords",
        default="Am7,Fmaj7,Cmaj7,Gmaj7,Dm7,Em7",
        help="progression; default is the A-minor roadmap the cyberpunk plan produced",
    )
    args = ap.parse_args()

    chords = [c.strip() for c in args.chords.split(",") if c.strip()]
    weights = plan_pitch_weights(chords)
    print(f"progression: {' '.join(chords)}")
    print(f"pitch weights: {np.round(weights, 3).tolist()}\n")

    total_a: list[float] = []
    total_b: list[float] = []
    for role, stem in (("rhythm", "rhythm"), ("harmonic", "harmonic"), ("vocal", "vocal")):
        pool = measured_pool(stem, args.pool)
        if len(pool) < args.top:
            print(f"{role:9s} pool={len(pool)} -- too few measured slices yet, skipped")
            continue
        legacy = rank_candidates(
            [dict(r) for r in pool], role, args.key, args.bpm, require_on_disk=False
        )[: args.top]
        aware = rank_candidates(
            [dict(r) for r in pool],
            role,
            args.key,
            args.bpm,
            require_on_disk=False,
            pitch_weights=weights,
        )[: args.top]
        fa, fb = mean_fit(legacy, weights), mean_fit(aware, weights)
        overlap = len({p["file_path"] for p in legacy} & {p["file_path"] for p in aware})
        total_a.append(fa)
        total_b.append(fb)
        delta = (fb - fa) / fa * 100.0 if fa else 0.0
        print(
            f"{role:9s} pool={len(pool):5d}  legacy={fa:.3f}  chord-aware={fb:.3f}  "
            f"{delta:+.1f}%   same picks: {overlap}/{args.top}"
        )
        print(f"          legacy picks:      {by_band(legacy, weights, CONFIDENCE_BYPASS)}")
        print(f"          chord-aware picks: {by_band(aware, weights, CONFIDENCE_BYPASS)}")

    if total_a:
        a, b = float(np.mean(total_a)), float(np.mean(total_b))
        print(
            f"\noverall harmonic fit: legacy={a:.3f} -> chord-aware={b:.3f} "
            f"({(b - a) / a * 100.0:+.1f}%)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
