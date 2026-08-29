# D:\MusicDatasets\scripts\test_frame_alignment.py
"""
Compares two ways of turning bar/beat into a sample frame:

  spec formula   F_beat = floor(60/BPM * fs), then multiply
  round once     compute the absolute beat offset, multiply by the exact
                 frames-per-beat, round the result

Both are exact when 60/BPM*fs is a whole number. When it is not, rounding the
rate up front makes the error compound with every beat, while rounding once
keeps it bounded at half a frame.
"""

import os
import sys
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from track_constructor_engine import BinaryCompositeConstructor

SR = 44100
TS = 4
MAX_BAR = 300


def true_frame(bar, beat, bpm, ts=TS):
    """Exact position in frames, unrounded."""
    return ((bar - 1) * ts + (beat - 1.0)) * (60.0 / bpm) * SR


def spec_frame(bar, beat, bpm, ts=TS):
    """floor() the rate first, then multiply, as the spec prescribes."""
    spb = int(np.floor((60.0 / bpm) * SR))
    return (bar - 1) * (ts * spb) + int(round((beat - 1.0) * spb))


def main():
    print("Deviation from true musical time (frames)")
    print()

    failures = 0

    for bpm in (110.0, 128.0, 133.0, 174.0, 140.0, 120.0):
        recipe = {
            "bpm": bpm, "time_signature": [TS, 4], "total_bars": MAX_BAR,
            "bit_depth": 16,
            "arrangement": [{"bar": 1, "beat": 1.0, "slice_file": "x.wav"}]
        }
        eng = BinaryCompositeConstructor(recipe, ".")

        exact = eng.frames_per_beat_exact
        is_whole = abs(exact - round(exact)) < 1e-9

        print(f"  {bpm:>6.1f} BPM  exact rate {exact:>12.4f} frames/beat"
              f"  {'(whole)' if is_whole else '(fractional)'}")
        print(f"    {'bar':>5}  {'spec floor()':>14}  {'round once':>14}"
              f"  {'spec err':>10}  {'ours err':>10}")

        for bar in (1, 16, 64, 128, 256, 300):
            t = true_frame(bar, 1.0, bpm)
            s = spec_frame(bar, 1.0, bpm)
            o = eng.bar_beat_to_frame(bar, 1.0)
            print(f"    {bar:>5}  {s:>14,}  {o:>14,}"
                  f"  {s - t:>+9.1f}  {o - t:>+9.1f}")

        worst_spec = max(abs(spec_frame(b, 1.0, bpm) - true_frame(b, 1.0, bpm))
                         for b in range(1, MAX_BAR + 1))
        worst_ours = max(abs(eng.bar_beat_to_frame(b, 1.0) - true_frame(b, 1.0, bpm))
                         for b in range(1, MAX_BAR + 1))

        print(f"    worst over {MAX_BAR} bars:")
        print(f"      spec formula : {worst_spec:>9.1f} frames "
              f"({worst_spec / SR * 1000:>7.3f} ms)")
        print(f"      round once   : {worst_ours:>9.1f} frames "
              f"({worst_ours / SR * 1000:>7.3f} ms)")

        # Rounding once can never exceed half a frame, by construction
        if worst_ours > 0.5 + 1e-9:
            print(f"      FAIL: bounded error exceeded")
            failures += 1
        print()

    print("=" * 64)
    if failures:
        print(f"{failures} tempo(s) exceeded the half-frame bound.")
        return 1

    print("Rounding once stayed within half a frame at every tempo.")
    print("The spec's floor() form is exact only when 60/BPM*fs is whole;")
    print("otherwise its error grows linearly with bar number.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
