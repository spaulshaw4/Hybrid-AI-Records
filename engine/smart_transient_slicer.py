"""Batch CLI: phrase-slice raw packs into ``corpus_4s/{rhythm,harmonic,lead,vocal}``.

Calls ``dsp.smart_transient_slicer`` for trough + zero-crossing cuts, the −50 dBFS
gate, 5 ms fades, uploaded_slices refusal, and the Windows sleep lock. This file
does not re-implement those, and it does not apply a second fade.

Stem folders use the same path-keyword rules as ``db.index_578gb_corpus``.
Resample prefers scipy; librosa is optional.

``run_multiprocess_slicing`` takes an explicit file list — never a drive root.
"""
from __future__ import annotations

import argparse
import math
import multiprocessing as mp
import os
import re
import sys
from typing import Any

import numpy as np
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from db.index_578gb_corpus import infer_stem_type  # noqa: E402
from dsp.smart_transient_slicer import (  # noqa: E402
    MAX_DUR,
    MIN_DUR,
    NOMINAL_DUR,
    RawSourceError,
    allow_sleep,
    assert_raw_source,
    prevent_sleep,
    slice_audio,
    unique_base_name,
)

DEFAULT_RAW_PACKS = r"D:\MusicDatasets\raw_packs"
DEFAULT_RAW_STEMS = r"D:\MusicDatasets\raw_stems"
DEFAULT_INCOMING = r"D:\MusicDatasets\incoming"
DEFAULT_OUTPUT = r"D:\MusicDatasets\corpus_4s"
DEFAULT_WORKSTATION = r"D:\MusicDatasets"
DEFAULT_TARGET_SR = 44100
DEFAULT_WORKERS = 8
LAYER_DIRS = ("rhythm", "harmonic", "lead", "vocal")
_RE_SLICE_MARKERS = frozenset({"corpus_4s", "uploaded_slices", "uploaded_slice"})
SKIP_DIR_NAMES = frozenset(
    {
        "corpus_4s",
        "scratch",
        "releases",
        "uploaded_slices",
        "uploaded_slice",
        "archive",
        "renders",
        "node_modules",
        ".git",
        "logs",
        "database",
        "db",
        "models",
        "venv",
        ".venv",
        "scripts",
        "config",
        "monitoring",
        "api",
        "dsp",
        "engine",
        "server",
        "src",
        "tests",
        "__pycache__",
    }
)
_PHRASE_NAME_RE = re.compile(r"(_phrase_|_slice_)", re.I)


class EmptyRawInputError(FileNotFoundError):
    """No usable raw source tree (and fallbacks were empty)."""


class DriveRootError(ValueError):
    """Refuses to walk or Pool a drive / workstation root."""


def resolve_worker_count(requested: int | None = None) -> int:
    """Default ``min(8, cpu_count())``. An explicit ``--workers`` value is used as-is."""
    if requested is None:
        cpus = os.cpu_count() or DEFAULT_WORKERS
        return max(1, min(DEFAULT_WORKERS, int(cpus)))
    return max(1, int(requested))


def is_drive_or_workstation_root(path: str) -> bool:
    norm = os.path.normcase(os.path.normpath(os.path.abspath(path)))
    workstation = os.path.normcase(os.path.normpath(DEFAULT_WORKSTATION))
    _drive, tail = os.path.splitdrive(norm)
    if tail in ("", os.sep):
        return True
    return norm == workstation


def assert_not_drive_root(path: str) -> None:
    """Do not Pool or walk ``D:\\`` or ``D:\\MusicDatasets`` as ``--input``."""
    if is_drive_or_workstation_root(path):
        raise DriveRootError(
            f"Refusing to slice {path}: that is a drive or workstation root. "
            f"Pass a raw pack directory such as {DEFAULT_RAW_PACKS}, not D:\\ or D:\\MusicDatasets."
        )


def _has_source_wavs(path: str) -> bool:
    return os.path.isdir(path) and bool(collect_engine_wavs(path))


def _is_default_packs(path: str) -> bool:
    return os.path.normcase(os.path.normpath(path)) == os.path.normcase(
        os.path.normpath(DEFAULT_RAW_PACKS)
    )


def resolve_input_root(requested: str | None = None) -> str:
    """Prefer ``raw_packs``. Only that default may fall back to raw_stems / incoming."""
    chosen = requested or DEFAULT_RAW_PACKS
    if _has_source_wavs(chosen):
        return os.path.normpath(chosen)

    fallbacks = (DEFAULT_RAW_STEMS, DEFAULT_INCOMING)
    allow_fallback = (not requested) or _is_default_packs(chosen)
    if allow_fallback:
        for alt in fallbacks:
            if _has_source_wavs(alt):
                print(f"[INFO] {DEFAULT_RAW_PACKS} missing or empty; using {alt}")
                return os.path.normpath(alt)

    tried = [os.path.normpath(chosen), *fallbacks] if allow_fallback else [os.path.normpath(chosen)]
    raise EmptyRawInputError(
        "No raw source tree with WAVs. Do not invent packs and do not slice "
        f"corpus_4s or uploaded_slices. Looked at: {', '.join(tried)}"
    )


def collect_engine_wavs(raw_dir: str) -> list[str]:
    """Walk ``raw_dir`` for ``*.wav``, skipping nested corpus / live-slice / scratch trees.

    The starting directory itself is still scanned even if it is named
    ``uploaded_slices`` so the refusal path can see the files.
    """
    found: list[str] = []
    if not os.path.isdir(raw_dir):
        return found
    start = os.path.normcase(os.path.normpath(os.path.abspath(raw_dir)))
    for root, dirs, files in os.walk(raw_dir):
        dirs[:] = [name for name in dirs if name.lower() not in SKIP_DIR_NAMES]
        root_abs = os.path.normcase(os.path.normpath(os.path.abspath(root)))
        if root_abs != start:
            parts = {p.lower() for p in root.split(os.sep) if p}
            if parts & SKIP_DIR_NAMES:
                continue
        for name in files:
            if not name.lower().endswith(".wav"):
                continue
            if _PHRASE_NAME_RE.search(name):
                continue
            found.append(os.path.join(root, name))
    found.sort()
    return found


def _path_is_re_slice_root(path: str) -> str | None:
    parts = [p.lower() for p in os.path.normpath(path).split(os.sep) if p]
    for part in parts:
        if part in _RE_SLICE_MARKERS:
            return part
    return None


def assert_engine_source(raw_dir: str, wavs: list[str], allow: bool = False) -> None:
    """Refuse slice dumps and the 4s corpus itself unless the operator overrides."""
    if not allow:
        marker = _path_is_re_slice_root(raw_dir)
        if marker == "corpus_4s":
            raise RawSourceError(
                f"Refusing to slice {raw_dir}: that tree is already the 4s corpus. "
                "Pass --i-know-this-is-raw only if these are true source stems."
            )
    assert_raw_source(raw_dir, wavs, allow=allow)


def resample_to_sr(signal: np.ndarray, src_sr: int, target_sr: int) -> np.ndarray:
    """Change rate with scipy ``resample_poly``; librosa is optional; last resort is linear."""
    src = int(src_sr)
    dst = int(target_sr)
    data = np.asarray(signal)
    if src == dst or data.size == 0:
        return data

    if data.ndim == 1:
        data = data[:, np.newaxis]
        squeeze = True
    else:
        squeeze = False

    try:
        from scipy.signal import resample_poly

        div = math.gcd(src, dst)
        out = resample_poly(data, dst // div, src // div, axis=0)
        return out[:, 0] if squeeze else out
    except Exception:
        pass

    try:
        import librosa

        channels = []
        for ch in range(data.shape[1]):
            channels.append(librosa.resample(data[:, ch], orig_sr=src, target_sr=dst))
        stacked = np.column_stack(channels)
        return stacked[:, 0] if squeeze else stacked
    except Exception:
        pass

    n_src = data.shape[0]
    n_dst = max(1, int(round(n_src * float(dst) / float(src))))
    x_src = np.linspace(0.0, 1.0, n_src, endpoint=False)
    x_dst = np.linspace(0.0, 1.0, n_dst, endpoint=False)
    out = np.empty((n_dst, data.shape[1]), dtype=np.float64)
    for ch in range(data.shape[1]):
        out[:, ch] = np.interp(x_dst, x_src, np.asarray(data[:, ch], dtype=np.float64))
    return out[:, 0] if squeeze else out


def layer_output_dir(output_root: str, source_path: str) -> str:
    layer = infer_stem_type(source_path.lower())
    if layer not in LAYER_DIRS:
        layer = "harmonic"
    return os.path.join(output_root, layer)


def slice_one_source(
    input_path: str,
    output_root: str,
    *,
    target_sr: int = DEFAULT_TARGET_SR,
    nominal_dur: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Read one stem, resample if needed, then call ``dsp.slice_audio`` (one fade)."""
    data, sr = sf.read(input_path, always_2d=True)
    work_sr = int(sr)
    work = np.asarray(data)
    if work_sr != int(target_sr):
        work = resample_to_sr(work, work_sr, int(target_sr))
        work_sr = int(target_sr)
        if work.ndim == 1:
            work = work[:, np.newaxis]

    phrases = slice_audio(
        work,
        work_sr,
        slice_sec=nominal_dur,
        min_dur=min_dur,
        max_dur=max_dur,
    )
    dest_dir = layer_output_dir(output_root, input_path)
    result: dict[str, Any] = {
        "source": input_path,
        "sr": work_sr,
        "layer": os.path.basename(dest_dir),
        "written": [],
        "would_write": len(phrases),
        "dest_dir": dest_dir,
        "error": "",
    }
    if dry_run:
        return result

    os.makedirs(dest_dir, exist_ok=True)
    base = unique_base_name(input_path)
    written: list[str] = []
    for idx, chunk in enumerate(phrases):
        dest = os.path.join(dest_dir, f"{base}_phrase_{idx:04d}.wav")
        sf.write(dest, chunk, work_sr, subtype="PCM_24")
        written.append(dest)
    result["written"] = written
    return result


def _multiprocess_slice_one(job: tuple[Any, ...]) -> dict[str, Any]:
    """Top-level picklable worker. Delegates DSP cuts via ``slice_one_source``."""
    path, output_dir, target_sr, nominal_dur, min_dur, max_dur, dry_run = job
    try:
        return slice_one_source(
            str(path),
            str(output_dir),
            target_sr=int(target_sr),
            nominal_dur=float(nominal_dur),
            min_dur=float(min_dur),
            max_dur=float(max_dur),
            dry_run=bool(dry_run),
        )
    except Exception as exc:
        return {
            "source": str(path),
            "sr": 0,
            "layer": "harmonic",
            "written": [],
            "would_write": 0,
            "dest_dir": layer_output_dir(str(output_dir), str(path)),
            "error": str(exc),
        }


def _empty_slice_summary(raw_dir: str, output_root: str, dry_run: bool) -> dict[str, Any]:
    return {
        "raw": raw_dir,
        "corpus": output_root,
        "sources": 0,
        "written": 0,
        "would_write": 0,
        "errors": [],
        "dry_run": bool(dry_run),
        "workers": 1,
        "by_layer": {name: 0 for name in LAYER_DIRS},
    }


def _accumulate_slice_results(
    summary: dict[str, Any],
    results: list[dict[str, Any]],
    dry_run: bool,
) -> dict[str, Any]:
    for result in results:
        err = str(result.get("error") or "")
        if err:
            summary["errors"].append(f"{result.get('source')}: {err}")
            continue
        n = len(result["written"]) if not dry_run else int(result["would_write"])
        summary["written"] += len(result["written"])
        summary["would_write"] += int(result["would_write"])
        layer = str(result.get("layer") or "harmonic")
        if layer in summary["by_layer"]:
            summary["by_layer"][layer] += n
    return summary


def run_multiprocess_slicing(
    file_list: list[str],
    output_dir: str,
    workers: int = DEFAULT_WORKERS,
    *,
    target_sr: int = DEFAULT_TARGET_SR,
    nominal_dur: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Slice an explicit WAV list with ``multiprocessing.Pool``. Never a drive root.

    ``file_list`` must already be collected. Do not pass ``D:\\`` or
    ``D:\\MusicDatasets`` as ``output_dir``'s sibling walk — this function does
    not discover files itself.
    """
    n_workers = max(1, int(workers) if workers else resolve_worker_count(None))
    wavs = [os.path.normpath(p) for p in file_list if p]
    summary = _empty_slice_summary("", output_dir, dry_run)
    summary["sources"] = len(wavs)
    summary["workers"] = n_workers
    if not wavs:
        return summary

    jobs = [
        (path, output_dir, int(target_sr), float(nominal_dur), float(min_dur), float(max_dur), bool(dry_run))
        for path in wavs
    ]
    prevent_sleep()
    try:
        if not dry_run:
            os.makedirs(output_dir, exist_ok=True)
        if n_workers <= 1 or len(jobs) < 2:
            results = [_multiprocess_slice_one(job) for job in jobs]
        else:
            with mp.Pool(processes=n_workers) as pool:
                results = pool.map(_multiprocess_slice_one, jobs)
        _accumulate_slice_results(summary, results, dry_run)
    finally:
        allow_sleep()
    return summary


def slice_engine_batch(
    raw_dir: str,
    output_root: str,
    *,
    target_sr: int = DEFAULT_TARGET_SR,
    nominal_dur: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    dry_run: bool = False,
    limit: int = 0,
    allow_slice_dump: bool = False,
    workers: int = 1,
) -> dict[str, Any]:
    """Walk ``raw_dir`` into layer folders under ``output_root``. Sleep lock is reused."""
    assert_not_drive_root(raw_dir)
    if not os.path.isdir(raw_dir):
        raise FileNotFoundError(f"Raw input directory does not exist: {raw_dir}")

    wavs = collect_engine_wavs(raw_dir)
    assert_engine_source(raw_dir, wavs, allow=allow_slice_dump)
    if limit and limit > 0:
        wavs = wavs[: int(limit)]

    n_workers = max(1, int(workers))
    if n_workers > 1 and len(wavs) >= 2:
        summary = run_multiprocess_slicing(
            wavs,
            output_root,
            workers=n_workers,
            target_sr=target_sr,
            nominal_dur=nominal_dur,
            min_dur=min_dur,
            max_dur=max_dur,
            dry_run=dry_run,
        )
        summary["raw"] = raw_dir
        summary["corpus"] = output_root
        return summary

    summary = _empty_slice_summary(raw_dir, output_root, dry_run)
    summary["sources"] = len(wavs)
    summary["workers"] = n_workers
    if not wavs:
        return summary

    prevent_sleep()
    try:
        if not dry_run:
            os.makedirs(output_root, exist_ok=True)
        results: list[dict[str, Any]] = []
        for path in wavs:
            results.append(
                _multiprocess_slice_one(
                    (path, output_root, target_sr, nominal_dur, min_dur, max_dur, dry_run)
                )
            )
        _accumulate_slice_results(summary, results, dry_run)
    finally:
        allow_sleep()
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Phrase-slice raw packs into corpus_4s/{rhythm,harmonic,lead,vocal} "
            "via dsp.smart_transient_slicer (no second fade)."
        )
    )
    parser.add_argument(
        "--input",
        default=DEFAULT_RAW_PACKS,
        help=f"Source root (default {DEFAULT_RAW_PACKS}; falls back to raw_stems / incoming). Not D:\\.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=f"Corpus root (default {DEFAULT_OUTPUT})",
    )
    parser.add_argument("--dry-run", action="store_true", help="Count only; do not write files")
    parser.add_argument("--limit", type=int, default=0, help="Process at most N source files (0 = all)")
    parser.add_argument(
        "--i-know-this-is-raw",
        action="store_true",
        help="Override the uploaded_slices / 1.0s-dump / corpus_4s refusal",
    )
    parser.add_argument("--sr", type=int, default=DEFAULT_TARGET_SR, help="Target sample rate")
    parser.add_argument("--nominal-dur", type=float, default=NOMINAL_DUR)
    parser.add_argument("--min-dur", type=float, default=MIN_DUR)
    parser.add_argument("--max-dur", type=float, default=MAX_DUR)
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help=(
            f"Process pool size. Default {DEFAULT_WORKERS}, capped to "
            "min(8, cpu_count()) unless this flag is set."
        ),
    )
    return parser


def print_operator_commands() -> None:
    py = r"C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe"
    print("Stephen — stage true source stems, then run:", file=sys.stderr)
    print(
        f'  {py} engine\\smart_transient_slicer.py --input "{DEFAULT_RAW_PACKS}" '
        f'--output "{DEFAULT_OUTPUT}" --dry-run --limit 8 --workers 8',
        file=sys.stderr,
    )
    print(
        f'  {py} engine\\smart_transient_slicer.py --input "{DEFAULT_RAW_PACKS}" '
        f'--output "{DEFAULT_OUTPUT}" --limit 8 --workers 8',
        file=sys.stderr,
    )
    print(
        "Do not point this at uploaded_slices, corpus_4s, or D:\\MusicDatasets root. "
        "Smoke-index later with db\\index_578gb_corpus.py --limit N --workers 8 (not a full 50k walk).",
        file=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    workers = resolve_worker_count(args.workers)
    try:
        assert_not_drive_root(args.input)
        assert_engine_source(args.input, [], allow=args.i_know_this_is_raw)
        raw_dir = resolve_input_root(args.input)
        assert_not_drive_root(raw_dir)
        summary = slice_engine_batch(
            raw_dir,
            args.output,
            target_sr=args.sr,
            nominal_dur=args.nominal_dur,
            min_dur=args.min_dur,
            max_dur=args.max_dur,
            dry_run=args.dry_run,
            limit=args.limit,
            allow_slice_dump=args.i_know_this_is_raw,
            workers=workers,
        )
    except DriveRootError as exc:
        print(f"[REFUSED] {exc}", file=sys.stderr)
        print_operator_commands()
        return 2
    except EmptyRawInputError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        print_operator_commands()
        return 1
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
    layers = " ".join(f"{name}={count}" for name, count in summary["by_layer"].items())
    print(
        f"[COMPLETE] {mode}: sources={summary['sources']} "
        f"written={summary['written']} would_write={summary['would_write']} "
        f"errors={len(summary['errors'])} workers={summary.get('workers', workers)} "
        f"layers[{layers}]"
    )
    for err in summary["errors"][:8]:
        print(f"  [SKIP] {err}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
