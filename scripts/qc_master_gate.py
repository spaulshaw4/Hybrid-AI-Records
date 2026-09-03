"""Emit post-master QC JSON for the production orchestrator."""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


def measure(path: str) -> dict:
    data, sr = sf.read(path, always_2d=True)
    oversampled = resample_poly(data, 4, 1, axis=0)
    true_peak_dbtp = float(20.0 * np.log10(np.max(np.abs(oversampled)) + 1e-12))
    left = data[:, 0]
    right = data[:, 1] if data.shape[1] > 1 else data[:, 0]
    l_norm = left - np.mean(left)
    r_norm = right - np.mean(right)
    denom = (np.sqrt(np.sum(l_norm**2)) * np.sqrt(np.sum(r_norm**2))) + 1e-12
    phase = float(np.sum(l_norm * r_norm) / denom)
    return {
        "true_peak_dbtp": round(true_peak_dbtp, 3),
        "phase_correlation": round(phase, 3),
        "sample_rate": int(sr),
        "duration_sec": round(data.shape[0] / float(sr), 3),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input", required=True)
    args = parser.parse_args()
    if not os.path.isfile(args.input):
        print(json.dumps({"error": "missing_master"}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(measure(args.input)))
