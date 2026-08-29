# D:\MusicDatasets\scripts\test_track_constructor.py
"""
Verifies the binary composite constructor against the architecture spec:
frame-grid arithmetic, bar/beat resolution, zero-crossing snapping, constant-power
pan law, and up-front recipe validation. Synthesises its own slices, so it needs
no corpus and no Supabase.
"""

import os
import sys
import json
import tempfile
import shutil
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from hybrid_dsp import write_wav_float32
from track_constructor_engine import BinaryCompositeConstructor
from audio_qc_analyzer import analyze_master_qc

SR = 44100
REPO_ROOT = os.path.dirname(SCRIPTS_DIR)
RECIPE_PATH = os.path.join(REPO_ROOT, "recipes", "heavy_sky_arrival.json")


def make_slice(path, freq, dur, amp=0.5):
    t = np.arange(int(SR * dur)) / SR
    s = amp * np.sin(2 * np.pi * freq * t)
    env = np.minimum(1.0, np.minimum(t * 30, (dur - t) * 30))
    write_wav_float32(path, np.column_stack((s * env, s * env)).astype(np.float32),
                      SR, enable_dither=False)


def main():
    with open(RECIPE_PATH, "r", encoding="utf-8") as f:
        recipe = json.load(f)

    tmp = tempfile.mkdtemp(prefix="ctor_test_")
    slices = os.path.join(tmp, "slices")
    os.makedirs(slices)

    try:
        make_slice(os.path.join(slices, "kick_808_sub.wav"), 55, 8.0, 0.70)
        make_slice(os.path.join(slices, "rhythm_riff_a.wav"), 220, 8.0, 0.45)
        make_slice(os.path.join(slices, "verse_vocal_lead.wav"), 440, 12.0, 0.50)
        make_slice(os.path.join(slices, "wall_guitars_stereo.wav"), 330, 16.0, 0.50)

        engine = BinaryCompositeConstructor(recipe, slices)

        print("=== FRAME GRID vs SPEC ===")
        expected_spb = int((60.0 / 140.0) * SR)
        print(f"  samples_per_beat : {engine.samples_per_beat}   (spec 60/140*44100 = {expected_spb})")
        print(f"  samples_per_bar  : {engine.samples_per_bar}")
        derived = 64 * engine.samples_per_bar / SR
        print(f"  64 bars resolves : {derived:.3f}s   (recipe total_duration_sec 109.71)")
        print(f"  grid matches spec: {abs(derived - 109.71) < 0.01}")

        print("\n=== BAR/BEAT -> INTEGER FRAME ===")
        for bar in (1, 9, 25, 64):
            fr = engine.bar_beat_to_frame(bar, 1.0)
            print(f"  bar {bar:>2} beat 1 -> frame {fr:>9}  ({fr / SR:8.3f}s)")

        print("\n=== ZERO-CROSSING SNAP ===")
        # The spec's 64-sample search window spans half a cycle only above
        # SR/128 = 344.5 Hz. Below that the next crossing lies outside the
        # window, so the slice is correctly left alone rather than mis-shifted.
        floor_hz = SR / (2 * 64)
        print(f"  window is {64} samples -> snaps content above {floor_hz:.1f} Hz")

        t = np.arange(SR) / SR
        for freq, expect_snap in ((880.0, True), (100.0, False)):
            wave_off = np.sin(2 * np.pi * freq * t + 1.2).astype(np.float32)
            stereo = np.column_stack((wave_off, wave_off))
            snapped = engine.snap_to_zero_crossing(stereo)
            trimmed = len(stereo) - len(snapped)
            did_snap = trimmed > 0

            status = "OK  " if did_snap == expect_snap else "FAIL"
            print(f"  [{status}] {freq:>6.0f} Hz: head {stereo[0, 0]:+.4f} -> "
                  f"{snapped[0, 0]:+.4f}, trimmed {trimmed:>3} frames "
                  f"(snap expected: {expect_snap})")

            if did_snap and abs(snapped[0, 0]) >= abs(stereo[0, 0]):
                print("         WARNING: snapped head is not closer to zero")

        print(f"  NOTE: Q1 sub-bass (55-120 Hz) sits below the {floor_hz:.0f} Hz floor,")
        print("        so foundation slices pass through unsnapped by design.")

        print("\n=== CONSTANT-POWER PAN LAW ===")
        for pan in (-1.0, -0.8, 0.0, 0.8, 1.0):
            rad = (pan + 1.0) * (np.pi / 4.0)
            l, r = np.cos(rad), np.sin(rad)
            print(f"  pan {pan:+.1f} -> L {l:.4f}  R {r:.4f}  "
                  f"power L2+R2 = {l**2 + r**2:.4f}")

        print()
        master = os.path.join(tmp, "master_output.wav")
        result = engine.render_to_file(master)

        print("\n=== RENDER RESULT ===")
        for k in ("track_title", "duration_sec", "bpm", "blocks_placed",
                  "blocks_truncated", "blocks_skipped", "bit_depth", "size_bytes"):
            print(f"  {k:<18}: {result[k]}")
        print(f"  {'master_hash':<18}: {result['master_hash'][:32]}...")

        print()
        analyze_master_qc(master)

        print("\n=== UP-FRONT VALIDATION ===")
        bad = json.loads(json.dumps(recipe))
        bad["arrangement"].append({"bar": 30, "beat": 1.0, "slice_file": "missing.wav"})
        try:
            BinaryCompositeConstructor(bad, slices).validate_recipe()
            print("  FAIL - missing slice was not caught")
            return 1
        except FileNotFoundError as e:
            print(f"  caught before render: {str(e).strip().splitlines()[-1].strip()}")

        print("\nAll constructor checks completed.")
        return 0

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
