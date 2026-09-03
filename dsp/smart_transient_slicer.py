"""Phrase-boundary slicer: energy trough, then a nearby zero-crossing.

No librosa. Boundaries sit in a breath/rest (10 ms RMS trough) inside a
±250 ms window around the nominal N-second grid, then snap to a ZC within
±15 ms of that trough so cuts are not mid-transient.

Library functions raise or return. Only ``main()`` calls ``sys.exit``.
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys
from typing import Any

import numpy as np
import soundfile as sf

DEFAULT_RAW = r"D:\MusicDatasets\raw_stems"
DEFAULT_CORPUS = r"D:\MusicDatasets\corpus_4s"
SILENCE_FLOOR_DBFS = -50.0
SEARCH_WINDOW_MS = 250.0
TROUGH_RMS_MS = 10.0
ZC_NEAR_TROUGH_MS = 15.0
MICRO_FADE_MS = 5.0
NOMINAL_DUR = 4.0
MIN_DUR = 3.2
MAX_DUR = 4.8

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

_GENERIC_STEMS = frozenset(
    {"bass", "drums", "vocals", "other", "mixture", "mix", "accompaniment"}
)
_SLICE_DUMP_MARKERS = frozenset({"uploaded_slices", "uploaded_slice"})


class RawSourceError(ValueError):
    """``--raw`` looks like a 1.0s slice library, not source stems."""


def to_mono(signal: np.ndarray) -> np.ndarray:
    """Fold stereo ``(N, ch)`` to mid/mean; leave ``(N,)`` as float64."""
    data = np.asarray(signal, dtype=np.float64)
    if data.ndim == 1:
        return data
    if data.ndim == 2:
        return np.mean(data, axis=1)
    raise ValueError(f"expected (N,) or (N, ch), got shape {data.shape}")


def rms_dbfs(signal: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(np.asarray(signal, dtype=np.float64)))))
    if rms < 1e-12:
        return -120.0
    return float(20.0 * np.log10(rms))


def moving_rms(mono: np.ndarray, win_samples: int) -> np.ndarray:
    """Same-length moving RMS via a boxcar on squared samples."""
    x = np.asarray(mono, dtype=np.float64)
    win = max(1, int(win_samples))
    if x.size == 0:
        return x
    squared = np.square(x)
    kernel = np.ones(win, dtype=np.float64) / float(win)
    return np.sqrt(np.convolve(squared, kernel, mode="same"))


def find_nearest_zero_crossing(
    signal: np.ndarray,
    target_sample: int,
    search_window: int,
) -> int | None:
    """Nearest sign-change (or exact zero) of mid/mean around ``target_sample``.

    Returns ``None`` when the window has no crossing. Stereo is collapsed
    with ``to_mono`` first.
    """
    mono = to_mono(signal)
    n = int(mono.shape[0])
    if n == 0:
        return None
    target = int(np.clip(int(target_sample), 0, n - 1))
    radius = max(0, int(search_window))
    lo = max(0, target - radius)
    hi = min(n, target + radius + 1)
    if hi - lo < 2:
        if abs(float(mono[target])) <= 1e-12:
            return target
        return None

    region = mono[lo:hi]
    candidates: list[int] = []

    exact = np.flatnonzero(np.abs(region) <= 1e-12)
    candidates.extend(int(lo + i) for i in exact.tolist())

    signs = np.sign(region)
    # Keep exact zeros from splitting a crossing pair twice.
    signs[signs == 0.0] = 1.0
    changes = np.flatnonzero(np.diff(signs) != 0.0)
    for i in changes.tolist():
        a = lo + int(i)
        b = min(n - 1, a + 1)
        pick = a if abs(float(mono[a])) <= abs(float(mono[b])) else b
        candidates.append(int(pick))

    if not candidates:
        return None
    uniq = np.unique(np.asarray(candidates, dtype=np.int64))
    return int(uniq[np.argmin(np.abs(uniq - target))])


def find_phrase_zero_crossing(
    audio_mono: np.ndarray,
    target_sample: int,
    sr: int,
    search_window_ms: float = SEARCH_WINDOW_MS,
) -> int:
    """Snap a nominal grid sample to a rest, then to a nearby zero-crossing.

    1. Search ±``search_window_ms`` around ``target_sample``.
    2. 10 ms moving RMS — pick the energy trough (breath / rest).
    3. Nearest ZC within ±15 ms of that trough (not mid-transient).
    4. Fall back to the trough, then to ``target_sample``.
    """
    mono = to_mono(audio_mono)
    n = int(mono.shape[0])
    if n == 0:
        return 0
    target = int(np.clip(int(target_sample), 0, n - 1))
    radius = max(1, int(round(float(sr) * float(search_window_ms) / 1000.0)))
    lo = max(0, target - radius)
    hi = min(n, target + radius + 1)
    if hi <= lo:
        return target

    rms_win = max(1, int(round(float(sr) * TROUGH_RMS_MS / 1000.0)))
    local_rms = moving_rms(mono[lo:hi], rms_win)
    if local_rms.size == 0:
        return target

    peak = float(np.max(local_rms))
    span = float(np.max(local_rms) - np.min(local_rms))
    # Flat energy (steady tone): do not walk 250 ms off-grid; ZC at the target.
    if peak < 1e-12 or span < max(1e-8, 0.08 * peak):
        zc_flat = find_nearest_zero_crossing(
            mono,
            target,
            max(1, int(round(float(sr) * ZC_NEAR_TROUGH_MS / 1000.0))),
        )
        return int(zc_flat) if zc_flat is not None else target

    trough = int(lo + int(np.argmin(local_rms)))
    zc_radius = max(1, int(round(float(sr) * ZC_NEAR_TROUGH_MS / 1000.0)))
    zc = find_nearest_zero_crossing(mono, trough, zc_radius)
    if zc is not None:
        return int(zc)
    return int(trough)


def clamp_phrase_end(
    start: int,
    snapped: int,
    min_samples: int,
    max_samples: int,
    n: int,
) -> int:
    """Keep a snapped end inside ``[min_dur, max_dur]`` and ``[start+1, n]``."""
    end = int(np.clip(int(snapped), 0, int(n)))
    if end <= start:
        end = min(int(n), start + int(min_samples))
    duration = end - start
    if duration < int(min_samples):
        end = min(int(n), start + int(min_samples))
    if end - start > int(max_samples):
        end = start + int(max_samples)
    return int(min(int(n), max(start, end)))


def phrase_boundaries(
    mono: np.ndarray,
    sr: int,
    nominal_dur: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    search_window_ms: float = SEARCH_WINDOW_MS,
) -> list[int]:
    """Inclusive-start sample indices; last value is the end of the last phrase."""
    n = int(to_mono(mono).shape[0])
    min_s = max(1, int(round(float(min_dur) * sr)))
    max_s = max(min_s, int(round(float(max_dur) * sr)))
    nom_s = max(1, int(round(float(nominal_dur) * sr)))
    if n < min_s:
        return [0]

    bounds = [0]
    start = 0
    while start + min_s <= n:
        target = start + nom_s
        if target >= n:
            if n - start >= min_s:
                bounds.append(n)
            break
        snapped = find_phrase_zero_crossing(mono, target, sr, search_window_ms)
        end = clamp_phrase_end(start, snapped, min_s, max_s, n)
        if end <= start:
            break
        bounds.append(end)
        start = end
    return bounds


def apply_micro_fade(chunk: np.ndarray, sr: int, fade_ms: float = MICRO_FADE_MS) -> np.ndarray:
    data = np.asarray(chunk, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, np.newaxis]
        squeeze = True
    else:
        squeeze = False
    n = data.shape[0]
    fade_len = min(int(round(float(sr) * float(fade_ms) / 1000.0)), n // 2)
    if fade_len < 1:
        return chunk
    out = data.copy()
    ramp_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float64)[:, np.newaxis]
    ramp_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float64)[:, np.newaxis]
    out[:fade_len, :] *= ramp_in
    out[-fade_len:, :] *= ramp_out
    if squeeze:
        return out[:, 0]
    return out


def slice_audio(
    signal: np.ndarray,
    sr: int,
    slice_sec: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    search_window_ms: float = SEARCH_WINDOW_MS,
    silence_dbfs: float = SILENCE_FLOOR_DBFS,
) -> list[np.ndarray]:
    """In-memory phrases: variable length (~nominal ± window), silence dropped."""
    data = np.asarray(signal)
    if data.ndim == 1:
        data = data[:, np.newaxis]
    mono = to_mono(data)
    bounds = phrase_boundaries(
        mono,
        sr,
        nominal_dur=slice_sec,
        min_dur=min_dur,
        max_dur=max_dur,
        search_window_ms=search_window_ms,
    )
    phrases: list[np.ndarray] = []
    for i in range(len(bounds) - 1):
        start, end = bounds[i], bounds[i + 1]
        chunk = data[start:end]
        if rms_dbfs(chunk) < float(silence_dbfs):
            continue
        phrases.append(apply_micro_fade(chunk, sr))
    return phrases


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def unique_base_name(input_path: str) -> str:
    stem = os.path.splitext(os.path.basename(input_path))[0]
    if stem.lower() in _GENERIC_STEMS:
        parent = os.path.basename(os.path.dirname(input_path))
        return f"{slugify(parent)}__{slugify(stem)}"
    return slugify(stem) or stem


def slice_audio_file(
    input_path: str,
    output_dir: str,
    nominal_dur: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    search_window_ms: float = SEARCH_WINDOW_MS,
    silence_dbfs: float = SILENCE_FLOOR_DBFS,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Cut one WAV into ``{base}_phrase_{n:04d}.wav`` (PCM_24). Never ``sys.exit``."""
    data, sr = sf.read(input_path, always_2d=True)
    phrases = slice_audio(
        data,
        int(sr),
        slice_sec=nominal_dur,
        min_dur=min_dur,
        max_dur=max_dur,
        search_window_ms=search_window_ms,
        silence_dbfs=silence_dbfs,
    )
    result: dict[str, Any] = {
        "source": input_path,
        "sr": int(sr),
        "written": [],
        "would_write": len(phrases),
        "skipped_silent": 0,
    }
    bounds = phrase_boundaries(
        to_mono(data),
        int(sr),
        nominal_dur=nominal_dur,
        min_dur=min_dur,
        max_dur=max_dur,
        search_window_ms=search_window_ms,
    )
    silent = 0
    for i in range(len(bounds) - 1):
        chunk = data[bounds[i] : bounds[i + 1]]
        if rms_dbfs(chunk) < float(silence_dbfs):
            silent += 1
    result["skipped_silent"] = silent

    if dry_run:
        return result

    os.makedirs(output_dir, exist_ok=True)
    base = unique_base_name(input_path)
    written: list[str] = []
    for idx, chunk in enumerate(phrases):
        name = f"{base}_phrase_{idx:04d}.wav"
        dest = os.path.join(output_dir, name)
        sf.write(dest, chunk, int(sr), subtype="PCM_24")
        written.append(dest)
    result["written"] = written
    return result


def prevent_sleep() -> None:
    try:
        import ctypes

        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
    except Exception:
        pass


def allow_sleep() -> None:
    try:
        import ctypes

        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    except Exception:
        pass


def collect_raw_wavs(raw_dir: str) -> list[str]:
    files = glob.glob(os.path.join(raw_dir, "**", "*.wav"), recursive=True)
    return sorted(p for p in files if os.path.isfile(p))


def _path_looks_like_slice_dump(raw_dir: str) -> str | None:
    parts = [p.lower() for p in os.path.normpath(raw_dir).split(os.sep) if p]
    for part in parts:
        if part in _SLICE_DUMP_MARKERS or part.endswith("_1s") or part.endswith("_1.0s"):
            return f"path component {part!r} looks like a slice dump"
    return None


def _wavs_look_like_1s_dump(wavs: list[str], sample: int = 8) -> str | None:
    if not wavs:
        return None
    probe = wavs[: max(1, min(sample, len(wavs)))]
    one_sec = 0
    readable = 0
    for path in probe:
        try:
            info = sf.info(path)
        except Exception:
            continue
        readable += 1
        if 0.85 <= float(info.duration) <= 1.15:
            one_sec += 1
    if readable >= 3 and one_sec >= max(3, (readable * 2) // 3):
        return f"{one_sec}/{readable} probed files are ~1.0s slices"
    return None


def assert_raw_source(raw_dir: str, wavs: list[str], allow: bool = False) -> None:
    """Refuse ``uploaded_slices`` / 1.0s dumps unless ``allow`` is set."""
    if allow:
        return
    reason = _path_looks_like_slice_dump(raw_dir) or _wavs_look_like_1s_dump(wavs)
    if reason:
        raise RawSourceError(
            f"Refusing to slice {raw_dir}: {reason}. "
            "Pass --i-know-this-is-raw only if these are true source stems."
        )


def slice_raw_batch(
    raw_dir: str,
    corpus_dir: str,
    nominal_dur: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    dry_run: bool = False,
    limit: int = 0,
    allow_slice_dump: bool = False,
) -> dict[str, Any]:
    """Walk ``raw_dir/**/*.wav`` into ``corpus_dir``. Sleep lock is best-effort."""
    if not os.path.isdir(raw_dir):
        raise FileNotFoundError(f"Raw input directory does not exist: {raw_dir}")

    wavs = collect_raw_wavs(raw_dir)
    assert_raw_source(raw_dir, wavs, allow=allow_slice_dump)
    if limit and limit > 0:
        wavs = wavs[: int(limit)]

    summary: dict[str, Any] = {
        "raw": raw_dir,
        "corpus": corpus_dir,
        "sources": len(wavs),
        "written": 0,
        "would_write": 0,
        "skipped_silent": 0,
        "errors": [],
        "dry_run": bool(dry_run),
    }
    if not wavs:
        return summary

    prevent_sleep()
    try:
        if not dry_run:
            os.makedirs(corpus_dir, exist_ok=True)
        for path in wavs:
            try:
                result = slice_audio_file(
                    path,
                    corpus_dir,
                    nominal_dur=nominal_dur,
                    min_dur=min_dur,
                    max_dur=max_dur,
                    dry_run=dry_run,
                )
            except Exception as exc:
                summary["errors"].append(f"{path}: {exc}")
                continue
            summary["written"] += len(result["written"])
            summary["would_write"] += int(result["would_write"])
            summary["skipped_silent"] += int(result["skipped_silent"])
    finally:
        allow_sleep()
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Phrase-snap WAV slicer (trough + nearby zero-crossing). No librosa."
    )
    parser.add_argument("--raw", default=DEFAULT_RAW, help=f"Source root (default {DEFAULT_RAW})")
    parser.add_argument("--corpus", default=DEFAULT_CORPUS, help=f"Output root (default {DEFAULT_CORPUS})")
    parser.add_argument("--dry-run", action="store_true", help="Count only; do not write files")
    parser.add_argument("--limit", type=int, default=0, help="Process at most N source files (0 = all)")
    parser.add_argument(
        "--i-know-this-is-raw",
        action="store_true",
        help="Override the uploaded_slices / 1.0s-dump refusal",
    )
    parser.add_argument("--nominal-dur", type=float, default=NOMINAL_DUR)
    parser.add_argument("--min-dur", type=float, default=MIN_DUR)
    parser.add_argument("--max-dur", type=float, default=MAX_DUR)
    parser.add_argument("-i", "--input", default="", help="Optional single WAV (skips batch walk)")
    parser.add_argument("-o", "--output", default="", help="Output dir for -i, else --corpus")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.input:
            out_dir = args.output or args.corpus
            result = slice_audio_file(
                args.input,
                out_dir,
                nominal_dur=args.nominal_dur,
                min_dur=args.min_dur,
                max_dur=args.max_dur,
                dry_run=args.dry_run,
            )
            print(
                f"[OK] {args.input}: wrote {len(result['written'])} "
                f"(would_write={result['would_write']}, silent={result['skipped_silent']})"
            )
            return 0

        summary = slice_raw_batch(
            args.raw,
            args.corpus,
            nominal_dur=args.nominal_dur,
            min_dur=args.min_dur,
            max_dur=args.max_dur,
            dry_run=args.dry_run,
            limit=args.limit,
            allow_slice_dump=args.i_know_this_is_raw,
        )
    except RawSourceError as exc:
        print(f"[REFUSED] {exc}", file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1

    mode = "dry-run" if summary["dry_run"] else "write"
    print(
        f"[COMPLETE] {mode}: sources={summary['sources']} "
        f"written={summary['written']} would_write={summary['would_write']} "
        f"silent={summary['skipped_silent']} errors={len(summary['errors'])}"
    )
    for err in summary["errors"][:8]:
        print(f"  [SKIP] {err}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
