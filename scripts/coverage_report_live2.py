"""Read-only coverage audit, pass 2.

Fixes over pass 1:
  * role comes from the filename prefix (engine.stem_selector.role_from_filename),
    not stem_type, and ``mixture*`` slices are excluded the way the selector does
  * source-tree classification uses instr() instead of LIKE..ESCAPE, which
    silently matched nothing in pass 1
  * chroma confidence is banded against the measured distribution
  * per-cell source-track diversity is measured, so a cell that is large by row
    count but drawn from one song is visible as thin
Both databases are opened mode=ro; nothing is written.
"""
from __future__ import annotations

import collections
import json
import sqlite3

INDEX_DB = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
PROFILES_DB = r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db"
HISTORY_DB = r"C:\live_web_outputs\db\hybrid_mix_history.db"

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
BPM_LO, BPM_HI, BPM_BINS = 60.0, 180.0, 15
BPM_W = (BPM_HI - BPM_LO) / BPM_BINS

# Mirrors _ROLE_PREFIXES / _BANNED_PREFIXES / the sub_ token rule, in the same
# precedence order the Python helper uses.
ROLE_SQL = """
CASE
  WHEN lower(si.filename) LIKE 'mixture%' THEN 'mixture_excluded'
  WHEN lower(si.filename) LIKE 'sub!_%' ESCAPE '!'
       OR instr(lower(si.filename), '_sub_') > 0 THEN 'bass'
  WHEN lower(si.filename) LIKE 'bass%' OR lower(si.filename) LIKE '808%' THEN 'bass'
  WHEN lower(si.filename) LIKE 'drums%' OR lower(si.filename) LIKE 'drum%'
       OR lower(si.filename) LIKE 'perc%' OR lower(si.filename) LIKE 'kick%'
       OR lower(si.filename) LIKE 'snare%' OR lower(si.filename) LIKE 'hat%' THEN 'rhythm'
  WHEN lower(si.filename) LIKE 'vocals%' OR lower(si.filename) LIKE 'vocal%'
       OR lower(si.filename) LIKE 'vox%' THEN 'vocal'
  WHEN lower(si.filename) LIKE 'other%' OR lower(si.filename) LIKE 'harm%'
       OR lower(si.filename) LIKE 'pad%' OR lower(si.filename) LIKE 'synth%'
       OR lower(si.filename) LIKE 'guitar%' OR lower(si.filename) LIKE 'keys%'
       OR lower(si.filename) LIKE 'piano%' THEN 'harmonic'
  ELSE 'unmapped'
END
"""

NORMP = r"lower(replace(si.file_path, '/', '\'))"
SRC_SQL = """
CASE
  WHEN instr({p}, '\\dsd100\\')    > 0 THEN 'dsd100'
  WHEN instr({p}, '\\slakh\\')     > 0 THEN 'slakh'
  WHEN instr({p}, '\\medley\\')    > 0 THEN 'medley'
  WHEN instr({p}, '\\mtg\\')       > 0 THEN 'mtg'
  WHEN instr({p}, '\\fma\\')       > 0 THEN 'fma'
  WHEN instr({p}, '\\raw_packs\\') > 0 THEN 'raw_packs'
  WHEN instr({p}, '\\oneshots\\')  > 0 THEN 'oneshots'
  WHEN instr({p}, '\\corpus_4s\\') > 0 THEN 'corpus_4s'
  ELSE 'other'
END
""".format(p=NORMP)

ENERGY_SQL = (
    "CASE WHEN si.rms_db IS NULL THEN 'null' WHEN si.rms_db <= -60 THEN 'silent'"
    " WHEN si.rms_db < -30 THEN 'low' WHEN si.rms_db < -18 THEN 'mid' ELSE 'high' END")

BPMBIN_SQL = (
    "CASE WHEN si.estimated_bpm >= {lo} AND si.estimated_bpm < {hi}"
    " THEN CAST((si.estimated_bpm - {lo}) / {w} AS INTEGER) ELSE -1 END"
).format(lo=BPM_LO, hi=BPM_HI, w=BPM_W)

# Bands chosen from the measured quantiles (p25=.078 p50=.176 p75=.314 p90=.452).
CONF_SQL = """
CASE
  WHEN m.chroma_confidence IS NULL THEN 'none'
  WHEN m.chroma_confidence >= 0.45 THEN 'c5_very_strong'
  WHEN m.chroma_confidence >= 0.30 THEN 'c4_strong'
  WHEN m.chroma_confidence >= 0.18 THEN 'c3_moderate'
  WHEN m.chroma_confidence >= 0.08 THEN 'c2_weak'
  ELSE 'c1_noise'
END
"""

BIG = """
SELECT {src} AS src, {role} AS role, {bpmbin} AS bpmbin,
       si.detected_key, m.chroma_root, m.chroma_is_minor,
       {conf} AS confband, {energy} AS energy, COUNT(*) AS n
FROM slice_index si
LEFT JOIN prof.slice_musical m ON m.file_path = si.file_path
GROUP BY 1,2,3,4,5,6,7,8
""".format(src=SRC_SQL, role=ROLE_SQL, bpmbin=BPMBIN_SQL, conf=CONF_SQL, energy=ENERGY_SQL)

# Per-cell source-track diversity. Parent directory is the source track.
DIVERSITY = """
SELECT {role} AS role, {bpmbin} AS bpmbin, m.chroma_root, m.chroma_is_minor,
       COUNT(*) AS n,
       COUNT(DISTINCT substr(si.file_path, 1, length(si.file_path) - length(si.filename) - 1)) AS tracks
FROM slice_index si
JOIN prof.slice_musical m ON m.file_path = si.file_path
WHERE si.rms_db > -60 AND m.chroma_confidence >= 0.18
  AND si.estimated_bpm >= {lo} AND si.estimated_bpm < {hi}
  AND lower(si.filename) NOT LIKE 'mixture%'
GROUP BY 1,2,3,4
""".format(role=ROLE_SQL, bpmbin=BPMBIN_SQL, lo=BPM_LO, hi=BPM_HI)


def ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:{}?mode=ro".format(path.replace("\\", "/")), uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def occ(counter, n_cells, floor=5):
    vals = sorted(counter.values(), reverse=True)
    total, occupied = sum(vals), len(vals)
    ge = sum(1 for v in vals if v >= floor)
    run = half = ninety = 0
    for i, v in enumerate(vals, 1):
        run += v
        if not half and total and run >= .5 * total:
            half = i
        if not ninety and total and run >= .9 * total:
            ninety = i
    return {"cells": n_cells, "occupied": occupied, "zero": n_cells - occupied,
            "pct_zero": round(100 * (n_cells - occupied) / n_cells, 1),
            "below_floor": occupied - ge, "at_floor": ge,
            "pct_at_floor": round(100 * ge / n_cells, 1),
            "placed": total, "max_cell": vals[0] if vals else 0,
            "cells_50pct": half, "cells_90pct": ninety}


def main() -> int:
    out = {}
    conn = ro(INDEX_DB)
    try:
        conn.execute("ATTACH DATABASE ? AS prof",
                     ("file:{}?mode=ro".format(PROFILES_DB.replace("\\", "/")),))
        rows = conn.execute(BIG).fetchall()
        out["group_rows"] = len(rows)
        div = conn.execute(DIVERSITY).fetchall()
    finally:
        conn.close()

    role_counts = collections.Counter()
    src_counts = collections.Counter()
    src_role = collections.defaultdict(collections.Counter)
    conf_counts = collections.Counter()
    energy_counts = collections.Counter()
    agree_by_conf = collections.defaultdict(lambda: [0, 0])  # band -> [agree, total]
    grid24 = collections.Counter()
    grid24_usable = collections.Counter()
    grid_nokey = collections.Counter()
    role_key = collections.Counter()
    excluded = collections.Counter()

    USABLE_CONF = {"c3_moderate", "c4_strong", "c5_very_strong"}

    for (src, role, bpmbin, dkey, root, minor, confband, energy, n) in rows:
        src_counts[src] += n
        conf_counts[confband] += n
        energy_counts[energy] += n
        if role in ("mixture_excluded", "unmapped"):
            excluded[role] += n
            continue
        role_counts[role] += n
        src_role[src][role] += n

        if dkey and root is not None:
            try:
                di = NOTE_NAMES.index(dkey.strip().upper())
            except ValueError:
                di = None
            if di is not None:
                slot = agree_by_conf[confband]
                slot[1] += n
                if di == int(root) % 12:
                    slot[0] += n

        playable = energy in ("low", "mid", "high")
        in_range = bpmbin is not None and bpmbin >= 0
        if not (playable and in_range):
            continue
        grid_nokey[(bpmbin, role, energy)] += n
        if root is not None:
            cell = (bpmbin, int(root) % 12, int(minor or 0), role, energy)
            grid24[cell] += n
            role_key[(role, int(root) % 12, int(minor or 0))] += n
            if confband in USABLE_CONF:
                grid24_usable[cell] += n

    n24 = BPM_BINS * 24 * 4 * 3
    out["roles_from_filename"] = dict(role_counts.most_common())
    out["excluded"] = dict(excluded)
    out["sources"] = {"counts": dict(src_counts.most_common()),
                      "by_role": {k: dict(v) for k, v in src_role.items()}}
    out["conf_bands"] = dict(sorted(conf_counts.items()))
    out["energy"] = dict(energy_counts)
    out["key_agreement_by_conf"] = {
        b: {"agree": a, "total": t, "pct": round(100.0 * a / t, 1) if t else None}
        for b, (a, t) in sorted(agree_by_conf.items())}
    out["grid"] = {
        "all_24key": occ(grid24, n24),
        "usable_conf_24key": occ(grid24_usable, n24),
        "no_key_axis": occ(grid_nokey, BPM_BINS * 4 * 3),
    }

    per_role = {}
    for role in ("rhythm", "bass", "harmonic", "vocal"):
        a = collections.Counter({k: v for k, v in grid24.items() if k[3] == role})
        u = collections.Counter({k: v for k, v in grid24_usable.items() if k[3] == role})
        per_role[role] = {"all": occ(a, BPM_BINS * 24 * 3),
                          "usable": occ(u, BPM_BINS * 24 * 3)}
    out["per_role_grid"] = per_role

    # role x key(24) totals, collapsed over bpm+energy
    out["role_key_matrix"] = {
        "{}|{}{}".format(r, NOTE_NAMES[k], "m" if mi else "M"): n
        for (r, k, mi), n in sorted(role_key.items())}

    # ---- source-track diversity per cell ----
    dstats = {}
    for role in ("rhythm", "bass", "harmonic", "vocal"):
        cells = [(n, t) for (r, _b, _k, _mi, n, t) in div if r == role]
        if not cells:
            dstats[role] = {"cells": 0}
            continue
        singles = sum(1 for n, t in cells if t <= 1)
        few = sum(1 for n, t in cells if t <= 3)
        big_thin = sum(1 for n, t in cells if n >= 20 and t <= 3)
        dstats[role] = {
            "cells_with_data": len(cells),
            "cells_one_track_only": singles,
            "cells_le3_tracks": few,
            "cells_ge20_slices_but_le3_tracks": big_thin,
            "median_tracks_per_cell": sorted(t for _n, t in cells)[len(cells) // 2],
            "total_slices": sum(n for n, _t in cells),
        }
    out["cell_source_diversity"] = dstats

    # ---- render history ----
    h = ro(HISTORY_DB)
    try:
        out["history"] = {
            "pool_depth_by_role": h.execute(
                "SELECT role, MIN(c), ROUND(AVG(c),1), MAX(c) FROM ("
                " SELECT session_id, role, COUNT(*) c FROM mix_decisions"
                " GROUP BY session_id, role) GROUP BY role").fetchall(),
            "fit_spread": h.execute(
                "SELECT role, ROUND(MIN(score),3), ROUND(AVG(score),3), ROUND(MAX(score),3),"
                " COUNT(DISTINCT fit_key), COUNT(DISTINCT fit_groove),"
                " COUNT(DISTINCT fit_chord), COUNT(DISTINCT fit_bpm)"
                " FROM mix_decisions GROUP BY role").fetchall(),
            "distinct_files_offered": h.execute(
                "SELECT role, COUNT(DISTINCT file_path) FROM mix_decisions GROUP BY role"
            ).fetchall(),
        }
    finally:
        h.close()

    print(json.dumps(out, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
