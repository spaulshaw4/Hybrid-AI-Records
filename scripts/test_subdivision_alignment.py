# D:\MusicDatasets\scripts\test_subdivision_alignment.py
"""
Checks 16th-note subdivision placement and the bar-length tolerance test.

F_16th = floor(F_beat / 4) rounds a value that was itself already rounded, so
subdivision error stacks on top of the beat-rate error. This measures both
against exact musical time.
"""

import os
import sys
import numpy as np

SR = 44100
TS = 4


def spec_grid(bpm, ts=TS):
    """Rate-first rounding, as the spec prescribes."""
    fpb = int(np.floor((60.0 / bpm) * SR))
    return {"fpb": fpb, "fbar": fpb * ts, "f16": int(np.floor(fpb / 4.0))}


def spec_frame(bar, beat, sub16, grid):
    return ((bar - 1) * grid["fbar"]
            + int(round((beat - 1.0) * grid["fpb"]))
            + (sub16 - 1) * grid["f16"])


def true_frame(bar, beat, sub16, bpm, ts=TS):
    """Exact position: total 16ths from the start, times the exact 16th rate."""
    exact_beat = (60.0 / bpm) * SR
    total_beats = (bar - 1) * ts + (beat - 1.0) + (sub16 - 1) / 4.0
    return total_beats * exact_beat


def round_once_frame(bar, beat, sub16, bpm, ts=TS):
    """Absolute offset in beats, rounded exactly once."""
    exact_beat = (60.0 / bpm) * SR
    total_beats = (bar - 1) * ts + (beat - 1.0) + (sub16 - 1) / 4.0
    return int(round(total_beats * exact_beat))


def main():
    print("16th-note subdivision placement error")
    print()

    for bpm in (110.0, 128.0, 140.0):
        grid = spec_grid(bpm)
        exact_beat = (60.0 / bpm) * SR
        exact_16 = exact_beat / 4.0

        print(f"  {bpm:>6.1f} BPM")
        print(f"    exact  : {exact_beat:>11.4f} frames/beat   {exact_16:>10.4f} frames/16th")
        print(f"    spec   : {grid['fpb']:>11,} frames/beat   {grid['f16']:>10,} frames/16th")
        print(f"    16th rounding loss: {grid['f16'] - exact_16:>+.4f} frames per 16th")
        print()
        print(f"      {'position':>16}  {'spec':>12}  {'round once':>12}"
              f"  {'spec err':>10}  {'ours err':>10}")

        for bar, beat, sub in ((1, 1, 1), (1, 1, 4), (1, 4, 4),
                               (16, 3, 2), (64, 2, 3), (128, 4, 4)):
            t = true_frame(bar, beat, sub, bpm)
            s = spec_frame(bar, beat, sub, grid)
            o = round_once_frame(bar, beat, sub, bpm)
            label = f"b{bar} beat{beat} s{sub}"
            print(f"      {label:>16}  {s:>12,}  {o:>12,}"
                  f"  {s - t:>+9.1f}  {o - t:>+9.1f}")

        worst_s = 0.0
        worst_o = 0.0
        for bar in range(1, 129):
            for beat in range(1, TS + 1):
                for sub in range(1, 5):
                    t = true_frame(bar, beat, sub, bpm)
                    worst_s = max(worst_s, abs(spec_frame(bar, beat, sub, grid) - t))
                    worst_o = max(worst_o, abs(round_once_frame(bar, beat, sub, bpm) - t))

        print(f"    worst across 128 bars x {TS} beats x 4 sixteenths:")
        print(f"      spec       : {worst_s:>9.1f} frames ({worst_s / SR * 1000:>7.3f} ms)")
        print(f"      round once : {worst_o:>9.1f} frames ({worst_o / SR * 1000:>7.3f} ms)")
        print()

    print("=" * 70)
    print("Bar-length tolerance check (delta F <= 16 samples)")
    print()
    print("  A loop of K bars is acceptable when its length is within 16 samples")
    print("  of K * F_bar. Exact modulo rejects loops that are musically fine.")
    print()

    for bpm in (110.0, 128.0, 140.0):
        exact_bar = (60.0 / bpm) * SR * TS
        print(f"  {bpm:>6.1f} BPM, exact bar = {exact_bar:.4f} frames")
        print(f"      {'K bars':>7}  {'expected':>12}  {'exact modulo':>14}  {'within 16':>10}")

        for k in (1, 2, 4, 8):
            expected = int(round(k * exact_bar))
            # A real editor might cut a few samples off
            for offset in (0, 7, 23):
                length = expected + offset
                fpb_int = int(round((60.0 / bpm) * SR))
                modulo_ok = (length % fpb_int == 0)
                delta = abs(length - k * exact_bar)
                tol_ok = delta <= 16
                print(f"      {k:>7}  {length:>12,}  {str(modulo_ok):>14}"
                      f"  {str(tol_ok):>10}   (offset {offset:>2}, deltaF {delta:>6.1f})")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
