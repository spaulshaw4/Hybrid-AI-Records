"""Read-only coverage audit of slice_index against the proposed 4,320-cell grid.

Grid axes: 15 BPM bins (60-180) x 24 keys (12 major + 12 minor) x 4 buses x
3 energy tiers. Writes a JSON summary to stdout. Never writes to the database.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import sqlite3
import sys

DEFAULT_DB = r"D:\MusicDatasets\db\corpus_index.sqlite"

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Stephen's grid: 15 bins spanning 60-180 BPM => 8.0 BPM per bin.
BPM_LO, BPM_HI, BPM_BINS = 60.0, 180.0, 15
BPM_BIN_WIDTH = (BPM_HI - BPM_LO) / BPM_BINS

# Energy tiers from rms_db (dBFS). Fixed thresholds are the primary model; the
# tercile split is reported alongside as a sensitivity check because a fixed
# grid can collapse if the corpus loudness distribution is narrow.
ENERGY_LOW_MAX = -30.0
ENERGY_MID_MAX = -18.0

# The indexer's infer_stem_type() can only ever emit these four labels, and it
# folds "bass" into "harmonic" (_HARMONIC_KEYS includes "bass"), so the bass bus
# has no dedicated producer. Recovery from tags/path is measured separately.
STEM_TO_BUS = {
    "rhythm": "drums",
    "harmonic": "harmonic",
    "lead": "lead_vocal",
    "vocal": "lead_vocal",
    "bass": "bass",
}
BUSES = ["drums", "bass", "harmonic", "lead_vocal"]

_BASS_TOKENS = ("bass", "sub", "808", "bassline")
_BASS_NEGATIVE = ("bassoon", "bass drum", "bassdrum")

# Fallback sentinels written by the indexer when detection raises or bails out.
FALLBACK_KEY = "A"
FALLBACK_BPM = 120.0

SOURCE_TREES = (
    "musdb18",
    "dsd100",
    "slakh",
    "medley",
    "fma",
    "mtg",
    "fsd50k",
    "openmic",
)


def connect_ro(db_path: str) -> sqlite3.Connection:
    uri = "file:{}?mode=ro".format(db_path.replace("\\", "/"))
    conn = sqlite3.connect(uri, uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def bpm_bin(bpm: float | None) -> int | None:
    """Bin index 0-14, or None if the value is missing or outside 60-180."""
    if bpm is None:
        return None
    try:
        val = float(bpm)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(val) or val < BPM_LO or val >= BPM_HI:
        return None
    return min(BPM_BINS - 1, int((val - BPM_LO) / BPM_BIN_WIDTH))


def key_token(raw: object) -> str | None:
    """Normalised pitch class, or None if unusable. Mode is never present."""
    if raw is None:
        return None
    token = str(raw).strip()
    if not token:
        return None
    token = token.upper().replace("♭", "B").replace("♯", "#")
    # Strip any mode suffix if a future indexer starts emitting one.
    for suffix in (" MAJOR", " MINOR", "MAJ", "MIN", "M"):
        if token.endswith(suffix) and len(token) > len(suffix):
            token = token[: -len(suffix)].strip()
            break
    if token in NOTE_NAMES:
        return token
    return None


def energy_tier(rms_db: object) -> str | None:
    if rms_db is None:
        return None
    try:
        val = float(rms_db)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(val):
        return None
    if val < ENERGY_LOW_MAX:
        return "low"
    if val < ENERGY_MID_MAX:
        return "mid"
    return "high"


def bus_for(stem_type: object, tags: object, file_path: object, recover_bass: bool) -> str | None:
    stem = (str(stem_type) if stem_type is not None else "").strip().lower()
    bus = STEM_TO_BUS.get(stem)
    if bus is None:
        return None
    if recover_bass and bus == "harmonic":
        blob = "{} {}".format(tags or "", file_path or "").lower().replace("_", " ")
        if any(neg in blob for neg in _BASS_NEGATIVE):
            return bus
        if any(tok in blob.split() or tok in blob for tok in _BASS_TOKENS):
            return "bass"
    return bus


def source_of(file_path: object) -> str:
    blob = (str(file_path) if file_path is not None else "").lower().replace("\\", "/")
    parts = set(blob.split("/"))
    for tree in SOURCE_TREES:
        if tree in parts or "/{}/".format(tree) in blob:
            return tree
    return "other_corpus_4s"


def percentiles(values: list[float], points=(1, 5, 25, 50, 75, 95, 99)) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values)
    out = {}
    for p in points:
        idx = min(len(ordered) - 1, max(0, int(round((p / 100.0) * (len(ordered) - 1)))))
        out["p{}".format(p)] = round(ordered[idx], 2)
    return out


def analyse(db_path: str) -> dict:
    conn = connect_ro(db_path)
    try:
        total = conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]
        rows = conn.execute(
            "SELECT stem_type, detected_key, estimated_bpm, rms_db, tags, file_path,"
            " duration_sec, spectral_centroid FROM slice_index"
        ).fetchall()
    finally:
        conn.close()

    stem_counts = collections.Counter()
    bus_counts_naive = collections.Counter()
    bus_counts_recovered = collections.Counter()
    key_counts = collections.Counter()
    bpm_exact = collections.Counter()
    energy_counts = collections.Counter()
    source_counts = collections.Counter()
    source_bus = collections.defaultdict(collections.Counter)

    key_null = key_unparsed = 0
    key_is_fallback_sentinel = 0
    bpm_null = bpm_nonfinite = bpm_zero_or_neg = 0
    bpm_is_fallback_sentinel = 0
    bpm_out_of_grid = 0
    rms_null = 0
    rms_values: list[float] = []
    bpm_values: list[float] = []
    dur_values: list[float] = []

    grid = collections.Counter()          # naive bus mapping
    grid_recovered = collections.Counter()  # bass recovered from tags
    grid_12key = collections.Counter()
    grid_nokey = collections.Counter()     # bpm x bus x energy only
    placeable = 0

    for stem, raw_key, raw_bpm, raw_rms, tags, fpath, dur, _cent in rows:
        stem_counts[(str(stem) if stem is not None else "NULL").lower()] += 1
        src = source_of(fpath)
        source_counts[src] += 1

        # --- key quality ---
        if raw_key is None or not str(raw_key).strip():
            key_null += 1
            ktok = None
        else:
            ktok = key_token(raw_key)
            if ktok is None:
                key_unparsed += 1
        if ktok is not None:
            key_counts[ktok] += 1
            if ktok == FALLBACK_KEY:
                key_is_fallback_sentinel += 1

        # --- bpm quality ---
        if raw_bpm is None:
            bpm_null += 1
        else:
            try:
                bval = float(raw_bpm)
            except (TypeError, ValueError):
                bpm_nonfinite += 1
                bval = None
            else:
                if not math.isfinite(bval):
                    bpm_nonfinite += 1
                    bval = None
                elif bval <= 0.0:
                    bpm_zero_or_neg += 1
                else:
                    bpm_values.append(bval)
                    bpm_exact[round(bval, 1)] += 1
                    if abs(bval - FALLBACK_BPM) < 1e-6:
                        bpm_is_fallback_sentinel += 1
        bbin = bpm_bin(raw_bpm)
        if bbin is None and raw_bpm is not None:
            bpm_out_of_grid += 1

        # --- energy ---
        if raw_rms is None:
            rms_null += 1
        else:
            try:
                rv = float(raw_rms)
                if math.isfinite(rv):
                    rms_values.append(rv)
            except (TypeError, ValueError):
                pass
        tier = energy_tier(raw_rms)
        if tier:
            energy_counts[tier] += 1

        if dur is not None:
            try:
                dv = float(dur)
                if math.isfinite(dv):
                    dur_values.append(dv)
            except (TypeError, ValueError):
                pass

        bus_n = bus_for(stem, tags, fpath, recover_bass=False)
        bus_r = bus_for(stem, tags, fpath, recover_bass=True)
        if bus_n:
            bus_counts_naive[bus_n] += 1
        if bus_r:
            bus_counts_recovered[bus_r] += 1
            source_bus[src][bus_r] += 1

        if bbin is not None and tier is not None:
            if bus_n:
                grid_nokey[(bbin, bus_n, tier)] += 1
            if ktok is not None and bus_n:
                grid[(bbin, ktok, bus_n, tier)] += 1
                grid_12key[(bbin, ktok, bus_n, tier)] += 1
                placeable += 1
            if ktok is not None and bus_r:
                grid_recovered[(bbin, ktok, bus_r, tier)] += 1

    # --- occupancy against the declared 4,320-cell grid ---
    def occupancy(counter, n_cells: int) -> dict:
        occupied = len(counter)
        vals = sorted(counter.values(), reverse=True)
        ge5 = sum(1 for v in vals if v >= 5)
        lt5 = occupied - ge5
        zero = n_cells - occupied
        total_in = sum(vals)
        top10 = sum(vals[:10])
        # cells needed to hold 50% / 90% of placed slices
        half, ninety = 0, 0
        run = 0
        for i, v in enumerate(vals, 1):
            run += v
            if half == 0 and total_in and run >= 0.5 * total_in:
                half = i
            if ninety == 0 and total_in and run >= 0.9 * total_in:
                ninety = i
        return {
            "cells_total": n_cells,
            "cells_zero": zero,
            "cells_lt5": lt5,
            "cells_ge5": ge5,
            "cells_occupied": occupied,
            "pct_zero": round(100.0 * zero / n_cells, 2) if n_cells else 0.0,
            "pct_ge5": round(100.0 * ge5 / n_cells, 2) if n_cells else 0.0,
            "slices_placed": total_in,
            "max_cell": vals[0] if vals else 0,
            "top10_share_pct": round(100.0 * top10 / total_in, 2) if total_in else 0.0,
            "cells_holding_50pct": half,
            "cells_holding_90pct": ninety,
        }

    n_declared = BPM_BINS * 24 * len(BUSES) * 3
    n_12key = BPM_BINS * 12 * len(BUSES) * 3
    n_nokey = BPM_BINS * len(BUSES) * 3

    # Heatmap payload: bpm_bin x key, summed over bus+energy, plus per-bus slabs.
    heat_bpm_key = collections.Counter()
    for (b, k, _bus, _e), c in grid_recovered.items():
        heat_bpm_key[(b, k)] += c
    heat_bus_bpm = collections.Counter()
    for (b, _k, bus, _e), c in grid_recovered.items():
        heat_bus_bpm[(bus, b)] += c

    rms_sorted = sorted(rms_values)
    terciles = {}
    if rms_sorted:
        t1 = rms_sorted[len(rms_sorted) // 3]
        t2 = rms_sorted[2 * len(rms_sorted) // 3]
        tc = collections.Counter()
        for v in rms_values:
            tc["low" if v < t1 else ("mid" if v < t2 else "high")] += 1
        terciles = {"t1_db": round(t1, 2), "t2_db": round(t2, 2), "counts": dict(tc)}

    return {
        "db_path": db_path,
        "total_rows": total,
        "grid": {
            "declared_4320": occupancy(grid, n_declared),
            "reachable_12key_2160": occupancy(grid_12key, n_12key),
            "bass_recovered_4320": occupancy(grid_recovered, n_declared),
            "no_key_axis_180": occupancy(grid_nokey, n_nokey),
        },
        "placeable_rows": placeable,
        "quality": {
            "key_null": key_null,
            "key_unparsed": key_unparsed,
            "key_usable_pitchclass": sum(key_counts.values()),
            "key_equals_fallback_A": key_is_fallback_sentinel,
            "key_distribution": dict(key_counts.most_common()),
            "key_modes_present": 0,
            "bpm_null": bpm_null,
            "bpm_nonfinite": bpm_nonfinite,
            "bpm_zero_or_neg": bpm_zero_or_neg,
            "bpm_equals_fallback_120": bpm_is_fallback_sentinel,
            "bpm_out_of_60_180_grid": bpm_out_of_grid,
            "bpm_distinct_values": len(bpm_exact),
            "bpm_top25": bpm_exact.most_common(25),
            "bpm_percentiles": percentiles(bpm_values),
            "rms_null": rms_null,
            "rms_percentiles": percentiles(rms_values),
            "duration_percentiles": percentiles(dur_values),
        },
        "energy": {
            "thresholds_db": {"low_max": ENERGY_LOW_MAX, "mid_max": ENERGY_MID_MAX},
            "counts_fixed": dict(energy_counts),
            "terciles": terciles,
        },
        "buses": {
            "stem_type_raw": dict(stem_counts.most_common()),
            "naive": {b: bus_counts_naive.get(b, 0) for b in BUSES},
            "bass_recovered": {b: bus_counts_recovered.get(b, 0) for b in BUSES},
        },
        "sources": {
            "counts": dict(source_counts.most_common()),
            "by_bus": {k: dict(v) for k, v in source_bus.items()},
        },
        "heatmaps": {
            "bpm_key": {"{}|{}".format(b, k): c for (b, k), c in heat_bpm_key.items()},
            "bus_bpm": {"{}|{}".format(bus, b): c for (bus, b), c in heat_bus_bpm.items()},
        },
        "bpm_bin_edges": [
            [round(BPM_LO + i * BPM_BIN_WIDTH, 1), round(BPM_LO + (i + 1) * BPM_BIN_WIDTH, 1)]
            for i in range(BPM_BINS)
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=os.environ.get("CORPUS_INDEX_DB") or DEFAULT_DB)
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)
    if not os.path.isfile(args.db):
        print("[FATAL] no such db: {}".format(args.db), file=sys.stderr)
        return 2
    report = analyse(args.db)
    text = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("[OK] wrote {}".format(args.out))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
