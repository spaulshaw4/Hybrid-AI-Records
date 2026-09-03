"""Post-master 1024-point min/max peak JSON for the studio scrubber."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

import numpy as np
import soundfile as sf

DEFAULT_NUM_PEAKS = 1024


def _bin_edges(num_samples: int, num_peaks: int) -> np.ndarray:
    """
    Edges that span the whole file.

    ``np.linspace`` plus ``unique`` folds a remainder into neighbouring
    bins instead of dropping a short tail. When the file is shorter than
    ``num_peaks``, empty bins collapse so every sample is still covered
    (the payload may then contain fewer than ``num_peaks`` pairs).
    """
    if num_samples <= 0:
        return np.array([0], dtype=np.int64)
    bins = max(1, min(int(num_peaks), num_samples))
    edges = np.unique(np.round(np.linspace(0, num_samples, bins + 1)).astype(np.int64))
    if edges[0] != 0:
        edges = np.insert(edges, 0, 0)
    if edges[-1] != num_samples:
        edges = np.append(edges, num_samples)
    if edges.size < 2:
        return np.array([0, num_samples], dtype=np.int64)
    return edges


def compute_minmax_peaks(audio: np.ndarray, num_peaks: int = DEFAULT_NUM_PEAKS) -> tuple[np.ndarray, np.ndarray]:
    data = np.asarray(audio)
    if data.ndim == 1:
        lo = data
        hi = data
    else:
        lo = np.min(data, axis=1)
        hi = np.max(data, axis=1)
    n = int(lo.shape[0])
    if n == 0:
        empty = np.zeros(0, dtype=np.float64)
        return empty, empty
    edges = _bin_edges(n, num_peaks)
    starts = edges[:-1]
    mins = np.minimum.reduceat(lo.astype(np.float64, copy=False), starts)
    maxs = np.maximum.reduceat(hi.astype(np.float64, copy=False), starts)
    return mins, maxs


def peaks_payload(
    audio: np.ndarray,
    sr: int,
    num_peaks: int = DEFAULT_NUM_PEAKS,
) -> dict:
    data = np.asarray(audio)
    frames = int(data.shape[0])
    channels = 1 if data.ndim == 1 else int(data.shape[1])
    mins, maxs = compute_minmax_peaks(data, num_peaks=num_peaks)
    rate = int(sr)
    return {
        "sample_rate": rate,
        "channels": channels,
        "frames": frames,
        "duration_sec": float(frames / rate) if rate > 0 else 0.0,
        "num_peaks": int(mins.shape[0]),
        "min": mins.tolist(),
        "max": maxs.tolist(),
    }


def write_peaks_json(payload: dict, output_path: str) -> None:
    directory = os.path.dirname(os.path.abspath(output_path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
        os.replace(tmp, output_path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def generate_waveform_peaks(
    input_path: str,
    output_path: str,
    num_peaks: int = DEFAULT_NUM_PEAKS,
) -> dict:
    """Read audio, bin min/max peaks across the whole file, atomically write JSON."""
    if num_peaks < 1:
        raise ValueError("num_peaks must be >= 1")
    if not os.path.isfile(input_path):
        raise FileNotFoundError(input_path)
    data, sr = sf.read(input_path, always_2d=True)
    payload = peaks_payload(data, int(sr), num_peaks=num_peaks)
    write_peaks_json(payload, output_path)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Write min/max waveform peaks JSON for the studio scrubber")
    parser.add_argument("-i", "--input", required=True, help="Master WAV/AIFF path")
    parser.add_argument("-o", "--output", required=True, help="Destination .json path")
    parser.add_argument("--peaks", type=int, default=DEFAULT_NUM_PEAKS, help="Target bin count (default 1024)")
    args = parser.parse_args()
    try:
        payload = generate_waveform_peaks(args.input, args.output, num_peaks=args.peaks)
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    print(
        f"[PEAKS] {payload['num_peaks']} bins @ {payload['sample_rate']} Hz "
        f"({payload['duration_sec']:.3f}s) -> {args.output}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
