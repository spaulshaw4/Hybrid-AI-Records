"""Read-only coverage audit of the live corpus against the 4-bus / BPM / key grid.

Joins corpus_index_live.slice_index to hybrid_acoustic_profiles.slice_musical on
file_path (PK both sides) in a single grouped pass, then derives every statistic
in Python. Opens both databases mode=ro and never writes.
"""
from __future__ import annotations

import collections
import json
import math
import sqlite3

INDEX_DB = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
PROFILES_DB = r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db"
HISTORY_DB = r"C:\live_web_outputs\db\hybrid_mix_history.db"

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

BPM_LO, BPM_HI, BPM_BINS = 60.0, 180.0, 15
BPM_W = (BPM_HI - BPM_LO) / BPM_BINS

# Energy tiers in dBFS. "silent" is carved out below the low tier because a
# digitally-silent slice occupies a grid cell without being renderable.
SILENT_MAX, LOW_MAX, MID_MAX = -60.0, -30.0, -18.0

# Confidence bands for chroma_root/chroma_is_minor. Thresholds are chosen after
# inspecting the distribution; see the printed quantiles.
CONF_BANDS = ((0.02, "conf_hi"), (0.005, "conf_mid"), (0.0, "conf_lo"))

SRC_SQL = """
CASE
  WHEN lower(si.file_path) LIKE '%\\dsd100\\%' ESCAPE '\\' THEN 'dsd100'
  WHEN lower(si.file_path) LIKE '%\\slakh\\%'  ESCAPE '\\' THEN 'slakh'
  WHEN lower(si.file_path) LIKE '%\\medley\\%' ESCAPE '\\' THEN 'medley'
  WHEN lower(si.file_path) LIKE '%\\mtg\\%'    ESCAPE '\\' THEN 'mtg'
  WHEN lower(si.file_path) LIKE '%\\fma\\%'    ESCAPE '\\' THEN 'fma'
  WHEN lower(si.file_path) LIKE '%\\raw_packs\\%' ESCAPE '\\' THEN 'raw_packs'
  WHEN lower(si.file_path) LIKE '%\\oneshots\\%'  ESCAPE '\\' THEN 'oneshots'
  WHEN lower(si.file_path) LIKE '%\\corpus_4s\\%' ESCAPE '\\' THEN 'corpus_4s'
  ELSE 'other'
END
"""

ENERGY_SQL = (
    "CASE WHEN si.rms_db IS NULL THEN 'null'"
    " WHEN si.rms_db <= {s} THEN 'silent'"
    " WHEN si.rms_db <  {l} THEN 'low'"
    " WHEN si.rms_db <  {m} THEN 'mid' ELSE 'high' END"
).format(s=SILENT_MAX, l=LOW_MAX, m=MID_MAX)

BPMBIN_SQL = (
    "CASE WHEN si.estimated_bpm >= {lo} AND si.estimated_bpm < {hi}"
    " THEN CAST((si.estimated_bpm - {lo}) / {w} AS INTEGER) ELSE -1 END"
).format(lo=BPM_LO, hi=BPM_HI, w=BPM_W)

CONF_SQL = (
    "CASE WHEN m.chroma_confidence IS NULL THEN 'none'"
    " WHEN m.chroma_confidence >= {a} THEN 'conf_hi'"
    " WHEN m.chroma_confidence >= {b} THEN 'conf_mid' ELSE 'conf_lo' END"
).format(a=CONF_BANDS[0][0], b=CONF_BANDS[1][0])

BIG_QUERY = """
SELECT {src} AS src,
       si.stem_type,
       si.stem_type_ml,
       {bpmbin} AS bpmbin,
       si.detected_key,
       m.chroma_root,
       m.chroma_is_minor,
       {conf} AS confband,
       {energy} AS energy,
       COUNT(*) AS n
FROM slice_index si
LEFT JOIN prof.slice_musical m ON m.file_path = si.file_path
GROUP BY 1,2,3,4,5,6,7,8,9
""".format(src=SRC_SQL, bpmbin=BPMBIN_SQL, conf=CONF_SQL, energy=ENERGY_SQL)


def ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:{}?mode=ro".format(path.replace("\\", "/")), uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def bus_of(stem: str | None) -> str | None:
    s = (stem or "").strip().lower()
    if s in ("rhythm", "drums", "drum", "percussion"):
        return "drums"
    if s in ("bass", "sub"):
        return "bass"
    if s in ("vocal", "vox", "lead", "melody"):
        return "lead_vocal"
    if s in ("harmonic", "chords", "keys", "pad", "other"):
        return "harmonic"
    return None


def occupancy(counter: collections.Counter, n_cells: int, floor: int = 5) -> dict:
    vals = sorted(counter.values(), reverse=True)
    occupied = len(vals)
    total = sum(vals)
    ge = sum(1 for v in vals if v >= floor)
    run, half, ninety = 0, 0, 0
    for i, v in enumerate(vals, 1):
        run += v
        if not half and total and run >= 0.5 * total:
            half = i
        if not ninety and total and run >= 0.9 * total:
            ninety = i
    return {
        "cells_total": n_cells,
        "occupied": occupied,
        "zero": n_cells - occupied,
        "pct_zero": round(100.0 * (n_cells - occupied) / n_cells, 1) if n_cells else 0,
        "below_floor": occupied - ge,
        "at_or_above_floor": ge,
        "pct_at_floor": round(100.0 * ge / n_cells, 1) if n_cells else 0,
        "slices_placed": total,
        "max_cell": vals[0] if vals else 0,
        "cells_holding_50pct": half,
        "cells_holding_90pct": ninety,
    }


def main() -> int:
    out: dict = {}
    conn = ro(INDEX_DB)
    try:
        conn.execute("ATTACH DATABASE ? AS prof",
                     ("file:{}?mode=ro".format(PROFILES_DB.replace("\\", "/")),))

        out["total_rows"] = conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]

        # ---- column population / sentinel audit (one pass) ----
        pop = conn.execute("""
            SELECT COUNT(*),
              SUM(detected_key IS NULL OR TRIM(detected_key)=''),
              SUM(estimated_bpm IS NULL),
              SUM(estimated_bpm = 120.0),
              SUM(estimated_bpm < 60 OR estimated_bpm >= 180),
              SUM(rms_db IS NULL),
              SUM(rms_db <= -60),
              SUM(stem_type_ml IS NULL OR TRIM(stem_type_ml)=''),
              SUM(spectral_centroid IS NULL OR spectral_centroid = 0),
              SUM(duration_sec IS NULL OR duration_sec <= 0)
            FROM slice_index""").fetchone()
        out["population"] = dict(zip(
            ["rows", "key_blank", "bpm_null", "bpm_eq_120", "bpm_out_of_range",
             "rms_null", "rms_silent", "stem_ml_blank", "centroid_zero", "dur_bad"], pop))

        # ---- BPM comb ----
        comb = conn.execute(
            "SELECT estimated_bpm, COUNT(*) c FROM slice_index"
            " GROUP BY estimated_bpm ORDER BY c DESC LIMIT 15").fetchall()
        out["bpm_top15"] = comb
        out["bpm_distinct"] = conn.execute(
            "SELECT COUNT(DISTINCT estimated_bpm) FROM slice_index").fetchone()[0]

        # ---- chroma confidence quantiles (profiles side only) ----
        qs = {}
        n_prof = conn.execute("SELECT COUNT(*) FROM prof.slice_musical").fetchone()[0]
        for p in (1, 5, 10, 25, 50, 75, 90, 95, 99):
            off = max(0, int(n_prof * p / 100.0) - 1)
            qs["p{}".format(p)] = conn.execute(
                "SELECT chroma_confidence FROM prof.slice_musical"
                " ORDER BY chroma_confidence LIMIT 1 OFFSET ?", (off,)).fetchone()[0]
        out["chroma_conf_quantiles"] = qs
        out["profiles_rows"] = n_prof

        # ---- transient density + downbeat sanity ----
        out["groove"] = dict(zip(
            ["td_null", "td_zero", "dbp_null", "abpm_null", "abpm_distinct"],
            conn.execute("""
                SELECT SUM(transient_density IS NULL), SUM(transient_density = 0),
                       SUM(downbeat_phase IS NULL), SUM(analyzed_bpm IS NULL),
                       COUNT(DISTINCT analyzed_bpm)
                FROM prof.slice_musical""").fetchone()))

        # ---- the single grouped join pass ----
        rows = conn.execute(BIG_QUERY).fetchall()
        out["group_rows"] = len(rows)
    finally:
        conn.close()

    # ================= derive everything in Python =================
    bus_counts = collections.Counter()
    bus_counts_ml = collections.Counter()
    stem_counts = collections.Counter()
    stem_ml_counts = collections.Counter()
    src_counts = collections.Counter()
    src_bus = collections.defaultdict(collections.Counter)
    energy_counts = collections.Counter()
    conf_counts = collections.Counter()
    key_counts = collections.Counter()
    root_counts = collections.Counter()
    mode_counts = collections.Counter()
    agree = collections.Counter()      # (confband, agree?) -> n
    bpmbin_counts = collections.Counter()

    grid12 = collections.Counter()     # detected_key, 12 pitch classes
    grid24 = collections.Counter()     # chroma_root + is_minor, 24 keys
    grid24_conf = collections.Counter()   # same, confident + non-silent only
    grid24_render = collections.Counter()  # confident + non-silent + in-range bpm
    grid_nokey = collections.Counter()

    for (src, stem, stem_ml, bpmbin, dkey, root, is_minor, confband, energy, n) in rows:
        src_counts[src] += n
        stem_counts[(stem or "NULL")] += n
        stem_ml_counts[(stem_ml or "NULL")] += n
        energy_counts[energy] += n
        conf_counts[confband] += n
        bpmbin_counts[bpmbin] += n
        if dkey:
            key_counts[dkey] += n
        if root is not None:
            root_counts[NOTE_NAMES[int(root) % 12]] += n
            mode_counts["minor" if is_minor else "major"] += n

        bus = bus_of(stem)
        bus_ml = bus_of(stem_ml)
        if bus:
            bus_counts[bus] += n
            src_bus[src][bus] += n
        if bus_ml:
            bus_counts_ml[bus_ml] += n

        # key agreement: detected_key (pitch class) vs chroma_root
        if dkey and root is not None:
            try:
                di = NOTE_NAMES.index(dkey.strip().upper())
            except ValueError:
                di = None
            if di is not None:
                agree[(confband, di == int(root) % 12)] += n

        playable = energy in ("low", "mid", "high")
        in_range = bpmbin is not None and bpmbin >= 0

        if bus and playable and in_range:
            grid_nokey[(bpmbin, bus, energy)] += n
            if dkey:
                grid12[(bpmbin, dkey, bus, energy)] += n
            if root is not None:
                cell = (bpmbin, int(root) % 12, int(is_minor or 0), bus, energy)
                grid24[cell] += n
                if confband == "conf_hi":
                    grid24_conf[cell] += n
                    grid24_render[cell] += n

    n24 = BPM_BINS * 24 * 4 * 3
    n12 = BPM_BINS * 12 * 4 * 3
    nnk = BPM_BINS * 4 * 3

    out["buses"] = {
        "stem_type_raw": dict(stem_counts.most_common()),
        "stem_type_ml_raw": dict(stem_ml_counts.most_common(10)),
        "bus_from_stem_type": dict(bus_counts),
        "bus_from_stem_type_ml": dict(bus_counts_ml),
    }
    out["energy_counts"] = dict(energy_counts)
    out["conf_counts"] = dict(conf_counts)
    out["detected_key_counts"] = dict(key_counts.most_common())
    out["chroma_root_counts"] = dict(root_counts.most_common())
    out["chroma_mode_counts"] = dict(mode_counts)
    out["bpmbin_counts"] = dict(sorted(bpmbin_counts.items(), key=lambda kv: kv[0]))
    out["key_agreement"] = {
        "{}_{}".format(band, "agree" if ok else "disagree"): n
        for (band, ok), n in sorted(agree.items())
    }
    out["grid"] = {
        "declared_24key_4320": occupancy(grid24, n24),
        "detected_key_12_2160": occupancy(grid12, n12),
        "confident_24key_4320": occupancy(grid24_conf, n24),
        "no_key_axis_180": occupancy(grid_nokey, nnk),
    }
    out["sources"] = {
        "counts": dict(src_counts.most_common()),
        "by_bus": {k: dict(v) for k, v in src_bus.items()},
    }

    # per-bus occupancy of the 24-key x bpm x energy sub-grid (1080 cells each)
    per_bus = {}
    for bus in ("drums", "bass", "harmonic", "lead_vocal"):
        sub = collections.Counter(
            {k: v for k, v in grid24.items() if k[3] == bus})
        subc = collections.Counter(
            {k: v for k, v in grid24_conf.items() if k[3] == bus})
        per_bus[bus] = {
            "all": occupancy(sub, BPM_BINS * 24 * 3),
            "confident": occupancy(subc, BPM_BINS * 24 * 3),
        }
    out["per_bus_grid"] = per_bus

    # bpm x key(24) heatmap collapsed over bus+energy, confident rows only
    heat = collections.Counter()
    for (b, root, minor, _bus, _e), n in grid24_conf.items():
        heat[(b, root, minor)] += n
    out["heat_bpm_key_confident"] = {
        "{}|{}{}".format(b, NOTE_NAMES[r], "m" if mi else "M"): n
        for (b, r, mi), n in heat.items()}

    # ---- mix history: what was actually requested and how well it scored ----
    try:
        h = ro(HISTORY_DB)
        out["history"] = {
            "sessions": h.execute("SELECT COUNT(*) FROM mix_sessions").fetchone()[0],
            "decisions": h.execute("SELECT COUNT(*) FROM mix_decisions").fetchone()[0],
            "verdicts": h.execute("SELECT COUNT(*) FROM mix_verdicts").fetchone()[0],
            "by_role": h.execute(
                "SELECT role, COUNT(*), ROUND(AVG(score),3), ROUND(AVG(fit_key),3),"
                " ROUND(AVG(fit_bpm),3), ROUND(AVG(fit_groove),3), ROUND(AVG(fit_chord),3)"
                " FROM mix_decisions GROUP BY role ORDER BY 2 DESC").fetchall(),
            "chosen_by_role": h.execute(
                "SELECT role, COUNT(*), ROUND(AVG(score),3) FROM mix_decisions"
                " WHERE chosen=1 GROUP BY role").fetchall(),
            "sessions_detail": h.execute(
                "SELECT genre, song_key, scale, bpm, total_bars FROM mix_sessions").fetchall(),
            "pool_depth": h.execute(
                "SELECT session_id, role, COUNT(*) FROM mix_decisions"
                " GROUP BY session_id, role ORDER BY 3 ASC LIMIT 20").fetchall(),
        }
        h.close()
    except Exception as exc:
        out["history"] = {"error": str(exc)}

    print(json.dumps(out, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
