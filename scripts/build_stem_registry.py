# D:\MusicDatasets\scripts\build_stem_registry.py
"""
===============================================================================
HYBRID 1.0 - STEM REGISTRY BUILDER
===============================================================================
Indexes a sliced corpus into SQLite so the constructor can query by quadrant,
key, level, and frame alignment instead of scanning directories.

SQLite rather than JSON: a balanced corpus at 12,500 slices per genre across
221 genres is ~2.7M rows. A JSON registry that size must be parsed whole into
memory on every lookup, while SQLite gives indexed queries and incremental
writes.

What is measured versus inherited
---------------------------------
Exact from the file:      path, sample rate, frames, duration, channels,
                          bit depth, RMS, peak, DC offset
Derived, reliable:        quadrant role (band-energy fractions), tonal key
                          with a confidence ratio
Inherited, NOT detected:  source BPM

BPM is deliberately not estimated. A one-second slice at 140 BPM contains 2.33
beats, yielding at most two inter-onset intervals where tempo estimation needs
four or more. Any figure derived from that would be noise presented as data, so
the column is populated from the source track's metadata or left NULL.

Key is estimated from a chroma profile and is genuinely useful for tonal
material, but meaningless for percussion. key_confidence is the ratio of the
strongest pitch class to the second strongest; a noise burst scores about 1.13.
Below --key-confidence-floor the key is stored as NULL rather than guessed.
"""

import os
import sys
import wave
import sqlite3
import argparse
import time
from datetime import datetime, timezone

import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from genre_quadrant_engine import band_energy_fractions, FOUNDATION_MAX_HZ, AIR_MIN_HZ

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

QUADRANT_NAMES = {1: "Q1_Foundation", 2: "Q2_Harmonics", 3: "Q3_Leads", 4: "Q4_Aux"}

# Q4 is overloaded across the spec: the Cylinder Master Bus in the DSP chain,
# and a fourth stem category here for risers, crashes and atmospheres. This is
# the stem sense.
#
# Detected by filename only, never spectrally. A crash cymbal and a hi-hat have
# almost identical band-energy distribution, so an energy classifier would put
# both in Q3; what distinguishes an FX layer is its musical role, not its
# spectrum. Unmatched files fall through to spectral routing.
Q4_KEYWORDS = ("riser", "crash", "sweep", "fx", "atmos", "ambient", "impact",
               "whoosh", "downlifter", "uplifter", "reverse", "drone", "texture",
               "foley", "noise_sweep", "transition")

# Tolerance for the bar-length quantisation check, in samples.
#
# An exact modulo test is wrong at fractional tempos: a perfectly cut 1-bar loop
# at 110 BPM is 96218.18 frames, and 96218 % 24055 != 0, so exact division
# rejects a correct loop. Comparing against the true fractional bar length
# within a tolerance accepts it, which is what the +/-16 window is for.
GRID_TOLERANCE_SAMPLES = 16

DEFAULT_DB = "stem_registry.db"
BATCH_SIZE = 500
KEY_CONFIDENCE_FLOOR = 1.35

SCHEMA = """
CREATE TABLE IF NOT EXISTS stems (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT UNIQUE NOT NULL,
    filename        TEXT NOT NULL,
    genre           TEXT,
    quadrant        INTEGER,
    quadrant_name   TEXT,
    sample_rate     INTEGER NOT NULL,
    frames          INTEGER NOT NULL,
    duration_sec    REAL NOT NULL,
    channels        INTEGER NOT NULL,
    bit_depth       INTEGER NOT NULL,
    rms_dbfs        REAL,
    peak_dbfs       REAL,
    dc_offset       REAL,
    low_band_frac   REAL,
    high_band_frac  REAL,
    root_key        TEXT,
    key_confidence  REAL,
    source_bpm      REAL,
    grid_aligned    INTEGER,
    grid_beats      INTEGER,
    grid_delta_frames REAL,
    is_silent       INTEGER,
    indexed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stems_genre     ON stems (genre);
CREATE INDEX IF NOT EXISTS idx_stems_quadrant  ON stems (quadrant);
CREATE INDEX IF NOT EXISTS idx_stems_key       ON stems (root_key);
CREATE INDEX IF NOT EXISTS idx_stems_genre_q   ON stems (genre, quadrant);
CREATE INDEX IF NOT EXISTS idx_stems_rms       ON stems (rms_dbfs);
CREATE INDEX IF NOT EXISTS idx_stems_aligned   ON stems (grid_aligned);
"""


def read_wav_mono_and_meta(path):
    """Decode once, returning (stereo_float, mono_float, meta) or (None, None, err)."""
    try:
        with wave.open(path, "rb") as w:
            n_ch = w.getnchannels()
            sw = w.getsampwidth()
            fr = w.getframerate()
            nf = w.getnframes()
            raw = w.readframes(nf)
    except Exception as e:
        return None, None, f"unreadable: {e}"

    if nf == 0 or not raw:
        return None, None, "zero frames"

    try:
        if sw == 2:
            data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        elif sw == 3:
            usable = (len(raw) // 3) * 3
            padded = bytearray()
            for i in range(0, usable, 3):
                padded.extend(b"\x00" + raw[i:i + 3])
            data = np.frombuffer(bytes(padded), dtype="<i4").astype(np.float32) / 2147483648.0
        elif sw == 4:
            data = np.frombuffer(raw, dtype="<f4").astype(np.float32)
        else:
            return None, None, f"unsupported sample width {sw}"
    except Exception as e:
        return None, None, f"decode failed: {e}"

    if n_ch == 1:
        stereo = np.column_stack((data, data))
    else:
        usable = (len(data) // n_ch) * n_ch
        stereo = data[:usable].reshape(-1, n_ch)[:, :2]

    if len(stereo) == 0:
        return None, None, "no decodable samples"

    finite = np.isfinite(stereo).all(axis=1)
    if not finite.all():
        stereo = stereo[finite]
        if len(stereo) == 0:
            return None, None, "all samples non-finite"

    meta = {"channels": n_ch, "bit_depth": sw * 8, "sample_rate": fr, "frames": nf}
    return stereo, stereo.mean(axis=1), meta


def estimate_key(mono, sample_rate):
    """
    Chroma-based root estimate with a confidence ratio.

    Restricted to 55-2000 Hz: below that, bin resolution is too coarse to
    separate adjacent semitones, and above it harmonics of unrelated partials
    dominate the profile.
    """
    if len(mono) < 1024:
        return None, 0.0

    spec = np.abs(np.fft.rfft(mono * np.hanning(len(mono))))
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sample_rate)

    band = (freqs > 55.0) & (freqs < 2000.0)
    if not band.any():
        return None, 0.0

    pcp = np.zeros(12, dtype=np.float64)
    f_band = freqs[band]
    a_band = spec[band]

    midi = 69 + 12 * np.log2(np.maximum(f_band, 1e-9) / 440.0)
    classes = np.rint(midi).astype(int) % 12
    np.add.at(pcp, classes, a_band)

    if pcp.max() <= 1e-12:
        return None, 0.0

    order = np.argsort(pcp)[::-1]
    confidence = float(pcp[order[0]] / max(pcp[order[1]], 1e-12))

    return PITCH_NAMES[int(order[0])], confidence


def frames_per_beat_exact(bpm, sample_rate):
    """Unrounded. Rounding here is what makes the grid drift."""
    return (60.0 / bpm) * sample_rate


def check_grid_alignment(frames, bpm, sample_rate, ts_num=4,
                         tolerance=GRID_TOLERANCE_SAMPLES):
    """
    Returns (aligned, nearest_beats, delta_frames).

    Measures against the exact fractional beat length and reports the closest
    whole number of beats, so a loop cut a few samples short still passes.
    """
    fpb = frames_per_beat_exact(bpm, sample_rate)
    if fpb <= 0:
        return None, None, None

    beats = frames / fpb
    nearest = round(beats)

    if nearest < 1:
        return 0, nearest, abs(frames - nearest * fpb)

    delta = abs(frames - nearest * fpb)
    return (1 if delta <= tolerance else 0), int(nearest), float(delta)


def inspect_slice(path, genre=None, target_bpm=None, source_bpm=None,
                  key_floor=KEY_CONFIDENCE_FLOOR):
    stereo, mono, meta_or_err = read_wav_mono_and_meta(path)

    if stereo is None:
        return None, meta_or_err

    meta = meta_or_err
    sr = meta["sample_rate"]

    rms = float(np.sqrt(np.mean(stereo ** 2)))
    peak = float(np.max(np.abs(stereo)))

    rms_dbfs = float(20.0 * np.log10(rms + 1e-12))
    peak_dbfs = float(20.0 * np.log10(peak + 1e-12))

    low_frac, high_frac = band_energy_fractions(stereo, sr)

    lower_name = os.path.basename(path).lower()
    if any(k in lower_name for k in Q4_KEYWORDS):
        quadrant = 4
    elif low_frac >= 0.5 and low_frac > high_frac:
        quadrant = 1
    elif high_frac >= 0.5 and high_frac > low_frac:
        quadrant = 3
    else:
        quadrant = 2

    root_key, key_conf = estimate_key(mono, sr)
    if root_key is not None and key_conf < key_floor:
        root_key = None

    # Does the length land on a whole number of beats at the target tempo,
    # within tolerance? A slice that does not will sit off-grid when placed.
    grid_aligned = None
    grid_beats = None
    grid_delta = None
    if target_bpm:
        grid_aligned, grid_beats, grid_delta = check_grid_alignment(
            meta["frames"], target_bpm, sr)

    row = {
        "path": os.path.abspath(path),
        "filename": os.path.basename(path),
        "genre": genre,
        "quadrant": quadrant,
        "quadrant_name": QUADRANT_NAMES.get(quadrant),
        "sample_rate": sr,
        "frames": meta["frames"],
        "duration_sec": round(meta["frames"] / sr, 6) if sr else 0.0,
        "channels": meta["channels"],
        "bit_depth": meta["bit_depth"],
        "rms_dbfs": round(rms_dbfs, 3),
        "peak_dbfs": round(peak_dbfs, 3),
        "dc_offset": round(float(np.mean(mono)), 8),
        "low_band_frac": round(low_frac, 5),
        "high_band_frac": round(high_frac, 5),
        "root_key": root_key,
        "key_confidence": round(key_conf, 4),
        "source_bpm": source_bpm,
        "grid_aligned": grid_aligned,
        "grid_beats": grid_beats,
        "grid_delta_frames": round(grid_delta, 2) if grid_delta is not None else None,
        "is_silent": 1 if rms_dbfs < -90.0 else 0,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }

    return row, None


COLUMNS = ["path", "filename", "genre", "quadrant", "quadrant_name", "sample_rate",
           "frames", "duration_sec", "channels", "bit_depth", "rms_dbfs", "peak_dbfs",
           "dc_offset", "low_band_frac", "high_band_frac", "root_key", "key_confidence",
           "source_bpm", "grid_aligned", "grid_beats", "grid_delta_frames",
           "is_silent", "indexed_at"]

INSERT_SQL = (f"INSERT OR REPLACE INTO stems ({', '.join(COLUMNS)}) "
              f"VALUES ({', '.join('?' * len(COLUMNS))})")


def discover_slices(root):
    """Yield (path, genre). Genre is the immediate parent directory name."""
    for dirpath, _, filenames in os.walk(root):
        genre = os.path.basename(dirpath)
        for fn in filenames:
            if fn.lower().endswith(".wav"):
                yield os.path.join(dirpath, fn), genre


def build_registry(corpus_root, db_path, target_bpm=None, source_bpm=None,
                   key_floor=KEY_CONFIDENCE_FLOOR, limit=None, resume=True,
                   progress_every=2000):
    if not os.path.isdir(corpus_root):
        print(f"[REGISTRY] Corpus root does not exist: {corpus_root}")
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(db_path)) or ".", exist_ok=True)

    conn = sqlite3.connect(db_path)
    # WAL plus a relaxed sync: this is a rebuildable index, so durability on
    # every insert is not worth the order-of-magnitude write cost across
    # millions of rows.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)

    already = set()
    if resume:
        already = {r[0] for r in conn.execute("SELECT path FROM stems")}
        if already:
            print(f"[REGISTRY] Resuming: {len(already):,} slice(s) already indexed")

    print(f"[REGISTRY] Scanning {corpus_root}")
    print(f"[REGISTRY] Database  {db_path}")
    if target_bpm:
        print(f"[REGISTRY] Grid check against {target_bpm} BPM")

    batch = []
    indexed = skipped = failed = 0
    failures = []
    started = time.time()

    for path, genre in discover_slices(corpus_root):
        if limit and indexed >= limit:
            break

        if resume and os.path.abspath(path) in already:
            skipped += 1
            continue

        row, err = inspect_slice(path, genre=genre, target_bpm=target_bpm,
                                 source_bpm=source_bpm, key_floor=key_floor)

        if row is None:
            failed += 1
            if len(failures) < 20:
                failures.append(f"{os.path.basename(path)}: {err}")
            continue

        batch.append(tuple(row[c] for c in COLUMNS))
        indexed += 1

        if len(batch) >= BATCH_SIZE:
            conn.executemany(INSERT_SQL, batch)
            conn.commit()
            batch.clear()

        if indexed % progress_every == 0:
            rate = indexed / max(time.time() - started, 1e-9)
            print(f"  indexed {indexed:,} ({rate:,.0f}/s)")

    if batch:
        conn.executemany(INSERT_SQL, batch)
        conn.commit()

    elapsed = time.time() - started

    print()
    print("=" * 64)
    print("STEM REGISTRY BUILD COMPLETE")
    print("=" * 64)
    print(f"  indexed : {indexed:,}")
    print(f"  skipped : {skipped:,} (already present)")
    print(f"  failed  : {failed:,}")
    print(f"  elapsed : {elapsed:.1f}s"
          + (f" ({indexed/elapsed:,.0f}/s)" if elapsed > 0 and indexed else ""))

    if failures:
        print("\n  first failures:")
        for f in failures:
            print(f"    {f}")

    print_summary(conn)
    conn.close()
    return 0


def print_summary(conn):
    total = conn.execute("SELECT COUNT(*) FROM stems").fetchone()[0]
    if not total:
        return

    print(f"\n  registry totals ({total:,} slices)")

    print("\n  by quadrant:")
    for q, name, n in conn.execute(
            "SELECT quadrant, quadrant_name, COUNT(*) FROM stems "
            "GROUP BY quadrant ORDER BY quadrant"):
        print(f"    {name or 'unknown':<16} {n:>9,}  ({100.0*n/total:5.1f}%)")

    genres = conn.execute(
        "SELECT genre, COUNT(*) FROM stems GROUP BY genre ORDER BY COUNT(*) DESC LIMIT 12"
    ).fetchall()
    if genres:
        print("\n  top genres:")
        for g, n in genres:
            print(f"    {(g or 'unlabelled'):<26} {n:>9,}")

    keyed = conn.execute("SELECT COUNT(*) FROM stems WHERE root_key IS NOT NULL").fetchone()[0]
    print(f"\n  tonal centre found : {keyed:,} / {total:,} ({100.0*keyed/total:.1f}%)")
    print(f"  remainder recorded as NULL rather than guessed")

    silent = conn.execute("SELECT COUNT(*) FROM stems WHERE is_silent=1").fetchone()[0]
    print(f"  silent slices      : {silent:,}")

    aligned = conn.execute(
        "SELECT COUNT(*) FROM stems WHERE grid_aligned IS NOT NULL").fetchone()[0]
    if aligned:
        ok = conn.execute("SELECT COUNT(*) FROM stems WHERE grid_aligned=1").fetchone()[0]
        print(f"  grid aligned       : {ok:,} / {aligned:,} checked")

    bpm_known = conn.execute("SELECT COUNT(*) FROM stems WHERE source_bpm IS NOT NULL").fetchone()[0]
    print(f"  source BPM known   : {bpm_known:,} / {total:,}"
          f"{'  (pass --source-bpm to populate)' if not bpm_known else ''}")


def main():
    parser = argparse.ArgumentParser(description="Hybrid 1.0 stem registry builder")
    parser.add_argument("--corpus-root", required=True,
                        help=r"Root holding genre folders, e.g. D:\MusicDatasets\uploaded_slices")
    parser.add_argument("--db", default=None, help=f"SQLite path (default <corpus-root>/{DEFAULT_DB})")
    parser.add_argument("--target-bpm", type=float, default=None,
                        help="Flag slices whose length is not a whole number of beats at this tempo")
    parser.add_argument("--source-bpm", type=float, default=None,
                        help="Record this as the source tempo. Not detected from slices: a 1s "
                             "slice yields at most 2 inter-onset intervals where tempo needs 4+.")
    parser.add_argument("--key-confidence-floor", type=float, default=KEY_CONFIDENCE_FLOOR,
                        help="Store key as NULL below this chroma ratio (noise scores ~1.13)")
    parser.add_argument("--limit", type=int, default=None, help="Stop after N slices")
    parser.add_argument("--no-resume", action="store_true", help="Re-index everything")
    parser.add_argument("--summary-only", action="store_true", help="Print stats and exit")
    args = parser.parse_args()

    db_path = args.db or os.path.join(args.corpus_root, DEFAULT_DB)

    if args.summary_only:
        if not os.path.exists(db_path):
            print(f"[REGISTRY] No database at {db_path}")
            return 1
        conn = sqlite3.connect(db_path)
        print_summary(conn)
        conn.close()
        return 0

    return build_registry(
        args.corpus_root, db_path,
        target_bpm=args.target_bpm,
        source_bpm=args.source_bpm,
        key_floor=args.key_confidence_floor,
        limit=args.limit,
        resume=not args.no_resume
    )


if __name__ == "__main__":
    sys.exit(main())
