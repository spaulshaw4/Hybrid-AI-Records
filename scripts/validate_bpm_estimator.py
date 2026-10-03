"""Score BPM estimators against the tempo encoded in sample-pack filenames.

The corpus is full of names like ``..._124bpm_phrase_0003.wav``. That label is
free ground truth and it is the only tempo reference on this machine that was
not itself produced by the estimator under test.

It is pack-level truth, not per-slice truth: a 4 s excerpt of a 124 BPM loop can
honestly contain half-time or double-time material, and a pad tail can contain
no beat at all. Octave/triplet-folded agreement is therefore the fair headline;
raw agreement is reported alongside it as the pessimistic bound.

Slices are grouped by source loop and the groups are split by hash, so a loop
never straddles the dev and test halves.

    python scripts/validate_bpm_estimator.py --limit 1200
    python scripts/validate_bpm_estimator.py --limit 4000 --split test
"""
from __future__ import annotations

import argparse
import hashlib
import multiprocessing as mp
import os
import re
import sqlite3
import sys
import time

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

LIVE_INDEX = r"C:\live_web_outputs\db\corpus_index_live.sqlite"

_BPM_IN_NAME = re.compile(r"(?<![0-9])(\d{2,3})\s*_?bpm|bpm[ _-]?(\d{2,3})(?![0-9])", re.I)
_SLICE_SUFFIX = re.compile(r"_(?:phrase|slice|part|seg)?_?\d+\.wav$", re.I)

#: Factors a human would call "the same tempo". Octave plus triplet/dotted.
_FOLD_FACTORS = (0.25, 1.0 / 3.0, 0.5, 2.0 / 3.0, 1.0, 1.5, 2.0, 3.0, 4.0)


def label_from_path(path: str) -> int | None:
    """Pack tempo encoded in the filename, or None."""
    match = _BPM_IN_NAME.search(os.path.basename(path))
    if not match:
        return None
    value = int(match.group(1) or match.group(2))
    return value if 50 <= value <= 220 else None


def loop_key(path: str) -> str:
    """Source loop a slice came from, used to keep splits leak-free."""
    return _SLICE_SUFFIX.sub("", os.path.basename(path).lower())


def split_of(key: str) -> str:
    """Stable dev/test assignment. 50/50 on the loop key, not the slice."""
    digest = hashlib.sha1(key.encode("utf-8")).digest()
    return "dev" if digest[0] % 2 == 0 else "test"


def ground_truth(split: str, limit: int, seed: int) -> list[tuple[str, int, float]]:
    """``(path, label_bpm, old_estimate)`` for labelled slices in one split."""
    conn = sqlite3.connect(f"file:{LIVE_INDEX}?mode=ro", uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    rows: list[tuple[str, int, float]] = []
    for path, old in conn.execute("SELECT file_path, estimated_bpm FROM slice_index"):
        label = label_from_path(str(path))
        if label is None:
            continue
        if split != "all" and split_of(loop_key(str(path))) != split:
            continue
        rows.append((str(path), label, float(old or 0.0)))
    conn.close()
    rng = np.random.default_rng(seed)
    rng.shuffle(rows)  # type: ignore[arg-type]
    return rows[:limit] if limit else rows


def _score_one(path: str) -> tuple[float, float, float]:
    """``(old_bpm, new_bpm, new_conf)`` recomputed from audio for both paths."""
    from dsp.tempo_estimator import estimate_tempo
    from dsp.tempo_time_stretch import estimate_slice_bpm_or_none

    try:
        import soundfile as sf

        data, sr = sf.read(path, always_2d=True, dtype="float64")
    except Exception:
        return 0.0, 0.0, 0.0
    mono = np.asarray(data, dtype=np.float64).mean(axis=1)
    try:
        old = estimate_slice_bpm_or_none(mono, sr=int(sr))
    except Exception:
        old = None
    try:
        new, conf = estimate_tempo(data, int(sr))
    except Exception:
        new, conf = 0.0, 0.0
    return float(old or 0.0), float(new), float(conf)


def _folded_error(est: float, truth: float) -> float:
    if est <= 0.0 or truth <= 0.0:
        return float("inf")
    return min(abs(est * f - truth) / truth for f in _FOLD_FACTORS)


def metrics(est: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    usable = est > 0.0
    rel = np.full(est.shape, np.inf)
    rel[usable] = np.abs(est[usable] - truth[usable]) / truth[usable]
    folded = np.array([_folded_error(e, t) for e, t in zip(est, truth)])
    total = float(est.size)
    return {
        "n": total,
        "within3": 100.0 * float(np.sum(rel <= 0.03)) / total,
        "within6": 100.0 * float(np.sum(rel <= 0.06)) / total,
        "folded3": 100.0 * float(np.sum(folded <= 0.03)) / total,
        "folded6": 100.0 * float(np.sum(folded <= 0.06)) / total,
        "median_rel": 100.0 * float(np.median(rel[np.isfinite(rel)])) if usable.any() else 100.0,
        "median_folded": 100.0 * float(np.median(folded[np.isfinite(folded)])),
        "distinct": float(len(set(np.round(est[usable], 1).tolist()))),
        "outside_60_180": 100.0 * float(np.sum((est < 60.0) | (est > 180.0))) / total,
    }


def _print_table(name: str, old: dict[str, float], new: dict[str, float]) -> None:
    print(f"\n{name}  (n={int(old['n'])})")
    header = f"{'metric':<22}{'old':>12}{'new':>12}"
    print(header)
    print("-" * len(header))
    for key, label, suffix in (
        ("within3", "within +/-3%", "%"),
        ("within6", "within +/-6%", "%"),
        ("folded3", "folded +/-3%", "%"),
        ("folded6", "folded +/-6%", "%"),
        ("median_rel", "median rel err", "%"),
        ("median_folded", "median folded err", "%"),
        ("outside_60_180", "outside 60-180", "%"),
        ("distinct", "distinct values", ""),
    ):
        print(f"{label:<22}{old[key]:>11.1f}{suffix:<1}{new[key]:>11.1f}{suffix:<1}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", default="test", choices=("dev", "test", "all"))
    parser.add_argument("--limit", type=int, default=1500)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    parser.add_argument("--seed", type=int, default=20251003)
    parser.add_argument("--min-conf", type=float, default=0.0,
                        help="Also report the new estimator restricted to this confidence")
    args = parser.parse_args()

    rows = ground_truth(args.split, args.limit, args.seed)
    print(f"[BPM-EVAL] split={args.split} slices={len(rows)} workers={args.workers}", flush=True)
    if not rows:
        return 1

    t0 = time.time()
    with mp.Pool(processes=max(1, args.workers)) as pool:
        scored = pool.map(_score_one, [r[0] for r in rows], chunksize=16)
    elapsed = time.time() - t0
    print(f"[BPM-EVAL] scored in {elapsed:.1f}s ({len(rows) / max(elapsed, 1e-6):.1f} slices/s, "
          "both estimators)", flush=True)

    truth = np.array([r[1] for r in rows], dtype=np.float64)
    indexed = np.array([r[2] for r in rows], dtype=np.float64)
    old = np.array([s[0] for s in scored], dtype=np.float64)
    new = np.array([s[1] for s in scored], dtype=np.float64)
    conf = np.array([s[2] for s in scored], dtype=np.float64)

    _print_table("recomputed from audio", metrics(old, truth), metrics(new, truth))
    _print_table("as stored in slice_index vs new", metrics(indexed, truth), metrics(new, truth))
    if args.min_conf > 0.0:
        keep = conf >= args.min_conf
        if keep.any():
            _print_table(
                f"new restricted to confidence >= {args.min_conf}",
                metrics(indexed[keep], truth[keep]),
                metrics(new[keep], truth[keep]),
            )
            print(f"retained {100.0 * float(keep.mean()):.1f}% of slices")
    return 0


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
