"""Balance a stem mix to a target RMS with a peak safety ceiling."""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

TARGET_RMS_DBFS = -18.0
PEAK_SAFETY = 0.95
AUDIO_SUFFIXES = (".wav", ".flac", ".aif", ".aiff")


class StemMixError(ValueError):
    """Invalid mix inputs. Raised by the library; the CLI maps this to exit 1."""


def rms_dbfs(audio: np.ndarray) -> float:
    data = np.asarray(audio, dtype=np.float64)
    if data.size == 0:
        return float("-inf")
    rms = float(np.sqrt(np.mean(data * data)))
    return float(20.0 * np.log10(rms + 1e-12))


def _as_2d(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis]
    if data.ndim == 2:
        return data
    raise StemMixError("audio must be shape (N,) or (N, ch)")


def balance_mix(
    stems: list[np.ndarray],
    target_rms_dbfs: float = TARGET_RMS_DBFS,
    peak_safety: float = PEAK_SAFETY,
) -> np.ndarray:
    """Sum stems, scale to ``target_rms_dbfs``, then cap peak at ``peak_safety``.

    Peak safety wins: after the RMS scale, if the peak exceeds the ceiling the
    mix is turned down. Raises ``StemMixError`` on empty or invalid input.
    """
    if not stems:
        raise StemMixError("no stems to mix")
    arrays = [_as_2d(stem) for stem in stems]
    channels = max(arr.shape[1] for arr in arrays)
    length = max(arr.shape[0] for arr in arrays)
    if length == 0:
        raise StemMixError("stems have zero length")
    acc = np.zeros((length, channels), dtype=np.float64)
    for arr in arrays:
        padded = arr
        if arr.shape[1] < channels:
            extra = np.zeros((arr.shape[0], channels - arr.shape[1]), dtype=np.float64)
            padded = np.concatenate((arr, extra), axis=1)
        acc[: padded.shape[0]] += padded

    rms = float(np.sqrt(np.mean(acc * acc)))
    target_lin = 10.0 ** (float(target_rms_dbfs) / 20.0)
    if rms > 1e-12:
        acc *= target_lin / rms
    peak = float(np.max(np.abs(acc)))
    ceiling = float(peak_safety)
    if peak > ceiling and peak > 0:
        acc *= ceiling / peak
    return acc


def collect_audio_paths(paths: list[str], recursive: bool = False) -> list[str]:
    """Collect audio files. Directories are not walked unless ``recursive``."""
    found: list[str] = []
    for raw in paths:
        path = os.path.abspath(raw)
        if os.path.isfile(path):
            found.append(path)
            continue
        if not os.path.isdir(path):
            raise StemMixError(f"missing path: {raw}")
        if recursive:
            for root, _dirs, names in os.walk(path):
                for name in names:
                    if name.lower().endswith(AUDIO_SUFFIXES):
                        found.append(os.path.join(root, name))
        else:
            for name in os.listdir(path):
                candidate = os.path.join(path, name)
                if os.path.isfile(candidate) and name.lower().endswith(AUDIO_SUFFIXES):
                    found.append(candidate)
    found.sort()
    return found


def balance_files(
    paths: list[str],
    output_path: str,
    target_rms_dbfs: float = TARGET_RMS_DBFS,
    peak_safety: float = PEAK_SAFETY,
    recursive: bool = False,
) -> np.ndarray:
    import soundfile as sf

    files = collect_audio_paths(paths, recursive=recursive)
    if not files:
        raise StemMixError("no audio files found")
    stems: list[np.ndarray] = []
    sample_rate = None
    for path in files:
        data, sr = sf.read(path, always_2d=True)
        if sample_rate is None:
            sample_rate = sr
        elif sr != sample_rate:
            raise StemMixError(f"sample rate mismatch in {path}")
        stems.append(data)
    mix = balance_mix(stems, target_rms_dbfs=target_rms_dbfs, peak_safety=peak_safety)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    sf.write(output_path, mix, int(sample_rate or 44100), subtype="PCM_24")
    return mix


def main() -> int:
    parser = argparse.ArgumentParser(description="Mix stems to a target RMS with peak safety 0.95.")
    parser.add_argument("inputs", nargs="+", help="Wav/flac files or a single directory of files.")
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--target-rms", type=float, default=TARGET_RMS_DBFS)
    parser.add_argument("--peak-safety", type=float, default=PEAK_SAFETY)
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Walk subdirectories. Off by default so slice dumps are not ingested.",
    )
    args = parser.parse_args()
    try:
        mix = balance_files(
            args.inputs,
            args.output,
            target_rms_dbfs=args.target_rms,
            peak_safety=args.peak_safety,
            recursive=args.recursive,
        )
    except StemMixError as exc:
        print(f"[MIX ERROR] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[MIX ERROR] {exc}", file=sys.stderr)
        return 1
    print(f"[MIX] rms={rms_dbfs(mix):.2f} dBFS peak={float(np.max(np.abs(mix))):.4f} -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
