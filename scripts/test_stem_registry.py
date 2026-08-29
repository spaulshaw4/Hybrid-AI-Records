# D:\MusicDatasets\scripts\test_stem_registry.py
"""
Exercises the registry against the cases that previously failed:

  * beat-aligned slices at a fractional tempo (110 BPM), where an exact modulo
    check rejects a correctly cut loop
  * a deliberately off-grid slice, which must be flagged
  * FX filenames, which must route to Q4_Aux rather than being classified by
    spectrum into Q3
"""

import os
import sys
import shutil
import sqlite3
import tempfile

import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from hybrid_dsp import write_wav_float32
from build_stem_registry import build_registry, check_grid_alignment

SR = 44100
BPM = 110.0
TS = 4


def tone(frames, freq, amp=0.5, noise=False):
    t = np.arange(frames) / SR
    if noise:
        rng = np.random.default_rng(int(freq))
        s = amp * rng.standard_normal(frames) * np.exp(-t * 6)
    else:
        s = amp * (np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * freq * 2 * t))
    env = np.minimum(1.0, np.minimum(t * 200, (t[-1] - t) * 200 + 1e-9))
    return np.column_stack((s * env, s * env)).astype(np.float32)


def main():
    exact_beat = (60.0 / BPM) * SR
    exact_bar = exact_beat * TS

    print(f"{BPM} BPM: exact beat {exact_beat:.4f} frames, exact bar {exact_bar:.4f}")
    print()

    print("=== alignment check in isolation ===")
    for label, frames in (
        ("1 bar, cut exactly", int(round(exact_bar))),
        ("1 bar, 7 samples long", int(round(exact_bar)) + 7),
        ("1 bar, 23 samples long", int(round(exact_bar)) + 23),
        ("4 bars, cut exactly", int(round(4 * exact_bar))),
        ("fixed 1 second", SR),
    ):
        aligned, beats, delta = check_grid_alignment(frames, BPM, SR)
        legacy = (frames % int(round(exact_beat)) == 0)
        print(f"  {label:<24} {frames:>9,} frames -> aligned={bool(aligned)}"
              f"  nearest {beats} beats, delta {delta:.1f}"
              f"   (exact-modulo would say {legacy})")

    tmp = tempfile.mkdtemp(prefix="reg_test_")
    try:
        corpus = os.path.join(tmp, "uploaded_slices", "heavy_alternative_rock")
        os.makedirs(corpus)

        bar_frames = int(round(exact_bar))

        # Beat-aligned musical slices
        write_wav_float32(os.path.join(corpus, "slice_sub_bass_001.wav"),
                          tone(bar_frames, 55), SR, enable_dither=False)
        write_wav_float32(os.path.join(corpus, "slice_gtr_chord_001.wav"),
                          tone(bar_frames, 220), SR, enable_dither=False)
        write_wav_float32(os.path.join(corpus, "slice_lead_vox_001.wav"),
                          tone(bar_frames, 9000, noise=True), SR, enable_dither=False)

        # Off-grid: a fixed one-second slice
        write_wav_float32(os.path.join(corpus, "slice_offgrid_001.wav"),
                          tone(SR, 220), SR, enable_dither=False)

        # FX layers: spectrally these look like Q3, but role is Q4
        for fx in ("riser_uplifter_001.wav", "crash_impact_001.wav",
                   "atmos_drone_001.wav"):
            write_wav_float32(os.path.join(corpus, fx),
                              tone(bar_frames, 11000, noise=True), SR, enable_dither=False)

        db = os.path.join(tmp, "reg.db")
        print()
        build_registry(os.path.join(tmp, "uploaded_slices"), db,
                       target_bpm=BPM, source_bpm=BPM)

        conn = sqlite3.connect(db)

        print()
        print("=== per-slice results ===")
        print(f"  {'file':<28}{'quadrant':<16}{'aligned':<9}{'beats':<7}{'delta':>8}")
        for fn, qn, al, gb, gd in conn.execute(
                "SELECT filename, quadrant_name, grid_aligned, grid_beats, "
                "grid_delta_frames FROM stems ORDER BY filename"):
            print(f"  {fn:<28}{qn or '?':<16}{str(bool(al)):<9}"
                  f"{str(gb):<7}{gd if gd is not None else 0:>8.1f}")

        q4 = conn.execute("SELECT COUNT(*) FROM stems WHERE quadrant=4").fetchone()[0]
        aligned = conn.execute("SELECT COUNT(*) FROM stems WHERE grid_aligned=1").fetchone()[0]
        offgrid = conn.execute(
            "SELECT COUNT(*) FROM stems WHERE grid_aligned=0").fetchone()[0]

        print()
        print("=== assertions ===")
        checks = [
            ("FX routed to Q4_Aux", q4 == 3),
            ("beat-aligned slices pass", aligned == 6),
            ("fixed 1s slice flagged off-grid", offgrid == 1),
        ]
        ok = True
        for label, passed in checks:
            print(f"  {'OK  ' if passed else 'FAIL'} {label}")
            ok = ok and passed

        conn.close()
        return 0 if ok else 1

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
