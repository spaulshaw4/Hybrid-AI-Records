# D:\MusicDatasets\scripts\cylinder_premix_overlay.py
"""
Premix stage: vertical stem overlay, run before sequential bus summation.

Two distinct operations, deliberately separate steps:

  premix (this script)      VERTICAL   - N slices sounding simultaneously at one
                                         timeline position, producing density
  summation (cylinder_bus)  HORIZONTAL - premixed positions concatenated in
                                         sequence, producing duration

Doing overlay inside the summation step would collapse the timeline: summing 420
one-second slices on top of each other yields one second of audio, not a
seven-minute track. So premix consumes layers x positions slices and emits
exactly `positions` composites, leaving the concatenated length unchanged.

  420 positions x 4 layers = 1680 slices consumed -> 420 composites -> 7:00
  150 positions x 4 layers =  600 slices consumed -> 150 composites -> 2:30

Output goes to <work_dir>/premixed_stems/. cylinder_bus_summation.py prefers that
directory when present and falls back to raw_stems, so premix is optional.

DSP (gain staging, soft-knee limiting, dither) comes from hybrid_dsp.py so the
premix and final master passes behave consistently.
"""

import os
import sys
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hybrid_dsp import overlay_stems, write_wav_float32, linear_to_dbfs
import numpy as np


def build_premix(session_id, work_dir, layers, positions,
                 gain_mode="acoustic", threshold_dbfs=-3.0, ceiling_dbfs=-0.5,
                 bit_depth=16, enable_dither=True):
    print("\n================================================================")
    print(f"CYLINDER PREMIX - VERTICAL STEM OVERLAY FOR: {session_id}")
    print("================================================================")

    raw_stems_dir = os.path.join(work_dir, "raw_stems")
    if not os.path.exists(raw_stems_dir):
        raise FileNotFoundError(f"Raw stems directory not found at: {raw_stems_dir}")

    stem_files = sorted([f for f in os.listdir(raw_stems_dir) if f.lower().endswith(".wav")])

    if not stem_files:
        raise ValueError(f"No stem files found in {raw_stems_dir}")

    available = len(stem_files)
    max_positions = available // layers

    if max_positions == 0:
        raise ValueError(
            f"Only {available} stems available but {layers} layers requested; "
            f"need at least {layers} for a single position."
        )

    if positions > max_positions:
        print(f"[PREMIX] Requested {positions} positions but only {available} stems "
              f"available at {layers} layers. Reducing to {max_positions}.")
        positions = max_positions

    premix_dir = os.path.join(work_dir, "premixed_stems")
    os.makedirs(premix_dir, exist_ok=True)

    print(f"[PREMIX] Stems available : {available}")
    print(f"[PREMIX] Geometry        : {layers} layers x {positions} positions = {layers * positions} consumed")
    print(f"[PREMIX] Gain staging    : {gain_mode}")
    print(f"[PREMIX] Limiter         : {threshold_dbfs} dBFS knee -> {ceiling_dbfs} dBFS ceiling")
    print(f"[PREMIX] Export          : {bit_depth}-bit {'TPDF dithered' if enable_dither else 'no dither'}")
    print(f"[PREMIX] Output          : {premix_dir}")

    written = 0
    peak_overall = 0.0

    for pos in range(positions):
        group = []

        # Stride by position so each layer draws from a different region of the
        # pool. N consecutive slices would stack near-identical material and
        # produce mud rather than density.
        for layer in range(layers):
            idx = pos + (layer * positions)
            if idx >= available:
                break
            group.append(os.path.join(raw_stems_dir, stem_files[idx]))

        if not group:
            continue

        composite, sample_rate = overlay_stems(
            group,
            gain_mode=gain_mode,
            threshold_dbfs=threshold_dbfs,
            ceiling_dbfs=ceiling_dbfs
        )

        peak_overall = max(peak_overall, float(np.max(np.abs(composite))))

        out_path = os.path.join(premix_dir, f"premix_{pos:05d}.wav")
        write_wav_float32(out_path, composite, sample_rate,
                          target_bit_depth=bit_depth, enable_dither=enable_dither)
        written += 1

        if written % 50 == 0 or written == positions:
            print(f"  -> Premixed {written}/{positions} positions...")

    print(f"[SUCCESS] Premix complete: {written} composite position(s) in {premix_dir}")
    print(f"          Peak across composites: {linear_to_dbfs(peak_overall):.2f} dBFS")
    print(f"          Concatenated duration will be ~{written} second(s).")
    return premix_dir


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cylinder Premix - vertical stem overlay stage")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory (contains raw_stems)")
    parser.add_argument("--layers", type=int, default=4,
                        help="Stems overlaid simultaneously per position (default 4)")
    parser.add_argument("--positions", type=int, default=420,
                        help="Timeline positions to emit; equals final seconds (default 420 = 7:00)")
    parser.add_argument("--gain-mode", choices=["acoustic", "linear", "unity"], default="acoustic",
                        help="Pre-sum attenuation: 1/sqrt(N), 1/N, or none (default acoustic)")
    parser.add_argument("--threshold-dbfs", type=float, default=-3.0,
                        help="Soft saturation knee in dBFS (default -3.0)")
    parser.add_argument("--ceiling-dbfs", type=float, default=-0.5,
                        help="Hard ceiling in dBFS (default -0.5)")
    parser.add_argument("--bit-depth", type=int, choices=[16, 24], default=16,
                        help="Composite export bit depth (default 16)")
    parser.add_argument("--no-dither", action="store_true", help="Disable TPDF dither")
    args = parser.parse_args()

    build_premix(
        args.session, args.dir, args.layers, args.positions,
        gain_mode=args.gain_mode,
        threshold_dbfs=args.threshold_dbfs,
        ceiling_dbfs=args.ceiling_dbfs,
        bit_depth=args.bit_depth,
        enable_dither=not args.no_dither
    )
