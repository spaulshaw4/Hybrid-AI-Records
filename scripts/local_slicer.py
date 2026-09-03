# D:\MusicDatasets\scripts\local_slicer.py
"""
HYBRID 1.0 - DATASET INGESTION & SLICING ENGINE

Decodes source audio with libsndfile (in-process) rather than spawning ffmpeg.
Windows Application Control raises OSError WinError 4551 when it blocks the
ffmpeg binary, which stalls pydub's subprocess decode path; libsndfile 1.1+
reads MP3/FLAC/OGG/WAV natively inside the interpreter, so no process is
spawned and no policy gate applies.

Two ingestion modes:

  queue mode (default)  Slices incoming/<genre>/ and archives each source to
                        archive/<genre>/ once its slices are written.

  corpus mode (--source) Slices an external read-only corpus (DSD100, MUSDB18)
                        in place. Sources are NEVER moved or modified.

  corpus-4s (--corpus-4s) Same as corpus mode, but writes 4000ms slices to
                        corpus_4s/<genre>/ with zero-crossing snap, micro-fades,
                        and skip-existing resume markers.

Stem role is preserved in every output filename so genre_quadrant_engine.py can
route slices to Q1/Q2/Q3 by keyword instead of falling back to spectral
classification.
"""
import os
import re
import sys
import shutil
import argparse
from pathlib import Path

from math import gcd

import numpy as np

try:
    import soundfile as sf
except ImportError:
    print("[FATAL] soundfile is required. Install with: pip install soundfile")
    sys.exit(1)

try:
    from scipy import signal as _scipy_signal
except ImportError:
    _scipy_signal = None

INCOMING_DIR = Path(r"D:\MusicDatasets\incoming")
SLICES_DIR = Path(r"D:\MusicDatasets\uploaded_slices")
ARCHIVE_DIR = Path(r"D:\MusicDatasets\archive")
CORPUS_4S_DIR = Path(r"D:\MusicDatasets\corpus_4s")

AUDIO_EXTS = (".wav", ".mp3", ".flac", ".ogg", ".aiff", ".aif")

DEFAULT_SLICE_MS = 1000
CORPUS_4S_MS = 4000
DEFAULT_SILENCE_FLOOR_DBFS = -50.0
DEFAULT_FADE_MS = 5.0
DEFAULT_ZERO_CROSS_MS = 10.0

# The pipeline concatenates slices assuming a single uniform rate. A 48 kHz
# source left at its native rate would emit slices that play back pitched and
# time-shifted once summed against 44.1 kHz material.
DEFAULT_TARGET_RATE = 44100

# Generic stem filenames that carry no track identity on their own. When a
# source is named one of these, the parent directory supplies the track name.
GENERIC_STEM_NAMES = {"bass", "drums", "vocals", "other", "mixture", "mix", "accompaniment"}

# Full mixes defeat the point of a per-quadrant stem corpus.
MIXTURE_NAMES = {"mixture", "mix"}


def slugify(text: str) -> str:
    """Collapses arbitrary text into a filesystem-safe lowercase token."""
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def derive_base_name(path: Path) -> str:
    """Builds a collision-free slice prefix, preserving the stem role.

    DSD100 and MUSDB18 name every stem identically across tracks
    (bass.wav, drums.wav, ...), so the parent directory is folded in to keep
    '051 - AM Contra/bass.wav' distinct from '052 - ANiMAL/bass.wav'. The role
    is kept as the trailing token so downstream keyword routing still sees it.
    """
    stem = path.stem
    if stem.lower() in GENERIC_STEM_NAMES:
        return f"{slugify(path.parent.name)}__{slugify(stem)}"
    return slugify(stem)


def make_dc_blocker(sample_rate: int, cutoff_hz: float = 5.0):
    """Single-pole DC blocker coefficients: H(z) = (1 - z^-1) / (1 - r*z^-1)."""
    r = float(np.exp(-2.0 * np.pi * cutoff_hz / sample_rate))
    return ([1.0, -1.0], [1.0, -r])


def apply_dc_block(block: np.ndarray, coeffs, zi: np.ndarray | None):
    """Filters a block, carrying filter state across slice boundaries.

    State is threaded between calls so the highpass does not restart from zero
    at every slice, which would stamp a step transient onto the first samples
    of each exported asset.
    """
    if _scipy_signal is None:
        return block, None

    b, a = coeffs
    if zi is None:
        zi = _scipy_signal.lfilter_zi(b, a)
        zi = np.outer(zi, np.ones(block.shape[1])) * block[0]

    out, zf = _scipy_signal.lfilter(b, a, block, axis=0, zi=zi)
    return out.astype(np.float32), zf


def resample_polyphase(audio: np.ndarray, orig_rate: int, target_rate: int) -> np.ndarray:
    """Anti-aliased polyphase resampling across all channels.

    resample_poly applies the anti-imaging/anti-aliasing FIR that naive
    interpolation omits; reducing rate without it folds everything above the new
    Nyquist back into the audible band. Reduced by the GCD so 48000 -> 44100
    becomes up=147, down=160 rather than a huge intermediate rate.
    """
    if orig_rate == target_rate or _scipy_signal is None:
        return audio

    divisor = gcd(int(orig_rate), int(target_rate))
    up = int(target_rate) // divisor
    down = int(orig_rate) // divisor
    return _scipy_signal.resample_poly(audio, up, down, axis=0).astype(np.float32)


def rms_dbfs(block: np.ndarray) -> float:
    """RMS level in dBFS for float samples normalized to +/-1.0."""
    if block.size == 0:
        return -np.inf
    rms = float(np.sqrt(np.mean(np.square(block, dtype=np.float64))))
    if rms <= 0.0:
        return -np.inf
    return 20.0 * np.log10(rms)


def snap_to_zero_crossing(audio: np.ndarray, index: int, search: int) -> int:
    """Nearest sign change to `index`, searching outward, else `index`."""
    if search <= 0 or audio.shape[0] < 2:
        return index

    lo = max(1, index - search)
    hi = min(audio.shape[0] - 1, index + search)
    if hi <= lo:
        return index

    mono = audio[lo:hi, 0] if audio.ndim > 1 else audio[lo:hi]
    sign_change = np.nonzero(np.diff(np.signbit(mono)))[0]
    if sign_change.size == 0:
        return index

    candidates = sign_change + lo
    return int(candidates[np.argmin(np.abs(candidates - index))])


def apply_micro_fade(chunk: np.ndarray, fade_len: int) -> None:
    """In-place linear micro-fade. `chunk` must already be a copy."""
    if fade_len <= 0 or chunk.shape[0] <= fade_len * 2:
        return
    ramp = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)[:, None]
    chunk[:fade_len] *= ramp
    chunk[-fade_len:] *= ramp[::-1]


def complete_marker(out_dir: Path, base_name: str) -> Path:
    return out_dir / f"{base_name}.sliced"


def slice_one_file(
    src: Path,
    out_dir: Path,
    slice_ms: int,
    silence_floor: float,
    dry_run: bool,
    dc_block: bool = True,
    target_rate: int = DEFAULT_TARGET_RATE,
    skip_existing: bool = False,
    fade_ms: float = 0.0,
    zero_cross_ms: float = 0.0,
) -> tuple[int, int]:
    """Slices a single source file. Returns (written_or_kept, skipped_silent).

    Matching-rate sources without snap/fade stream block-at-a-time, since a
    398-second stereo file is ~140 MB as float32. Off-rate sources, or any
    run that snaps to zero-crossings / applies micro-fades, are read whole
    so the cut grid can shift without stamping a discontinuity at every
    slice boundary. Sources are never written or moved.
    """
    base_name = derive_base_name(src)
    marker = complete_marker(out_dir, base_name)
    if skip_existing and marker.exists():
        return (len(list(out_dir.glob(f"{base_name}_s*.wav"))), 0)

    with sf.SoundFile(str(src)) as handle:
        source_rate = handle.samplerate
        needs_resample = target_rate and source_rate != target_rate and _scipy_signal is not None
        rate = int(target_rate) if needs_resample else source_rate

        frames_per_slice = int(round(rate * (slice_ms / 1000.0)))
        if frames_per_slice <= 0:
            return (0, 0)

        use_cursor = bool(needs_resample or fade_ms > 0 or zero_cross_ms > 0)
        if use_cursor:
            whole = handle.read(dtype="float32", always_2d=True)
            if needs_resample:
                whole = resample_polyphase(whole, source_rate, rate)
            written, skipped = _slice_from_array(
                whole, rate, base_name, out_dir, frames_per_slice,
                silence_floor, dry_run, dc_block, skip_existing,
                fade_ms, zero_cross_ms,
            )
        else:
            written, skipped = _slice_streamed(
                handle, rate, base_name, out_dir, frames_per_slice,
                silence_floor, dry_run, dc_block, skip_existing,
            )

    if not dry_run:
        marker.write_text(
            f"source={src}\nwritten={written}\nskipped={skipped}\n",
            encoding="utf-8",
        )
    return (written, skipped)


def _write_slice(out_path: Path, block: np.ndarray, rate: int, dry_run: bool, skip_existing: bool) -> int:
    if skip_existing and out_path.exists():
        return 1
    if not dry_run:
        sf.write(str(out_path), block, rate, subtype="PCM_16")
    return 1


def _slice_streamed(handle, rate, base_name, out_dir, frames_per_slice,
                    silence_floor, dry_run, dc_block, skip_existing):
    written = skipped = index = 0
    coeffs = make_dc_blocker(rate) if dc_block else None
    zi = None
    for block in _stream_blocks(handle, frames_per_slice):
        if coeffs is not None:
            block, zi = apply_dc_block(block, coeffs, zi)
        if rms_dbfs(block) < silence_floor:
            skipped += 1
            index += 1
            continue
        written += _write_slice(
            out_dir / f"{base_name}_s{index:05d}.wav",
            block, rate, dry_run, skip_existing,
        )
        index += 1
    return written, skipped


def _slice_from_array(audio, rate, base_name, out_dir, frames_per_slice,
                      silence_floor, dry_run, dc_block, skip_existing,
                      fade_ms, zero_cross_ms):
    written = skipped = index = 0
    zc_search = int(zero_cross_ms * 0.001 * rate)
    fade_len = int(fade_ms * 0.001 * rate)
    coeffs = make_dc_blocker(rate) if dc_block else None
    zi = None
    cursor = 0

    while cursor + frames_per_slice <= audio.shape[0]:
        start = snap_to_zero_crossing(audio, cursor, zc_search) if zc_search else cursor
        end = start + frames_per_slice
        if end > audio.shape[0]:
            break

        chunk = np.array(audio[start:end], dtype=np.float32, copy=True)
        if coeffs is not None:
            chunk, zi = apply_dc_block(chunk, coeffs, zi)

        if rms_dbfs(chunk) < silence_floor:
            skipped += 1
            index += 1
            cursor = start + frames_per_slice
            continue

        out_path = out_dir / f"{base_name}_s{index:05d}.wav"
        if not (skip_existing and out_path.exists()) and fade_len > 0:
            apply_micro_fade(chunk, fade_len)
        written += _write_slice(out_path, chunk, rate, dry_run, skip_existing)
        index += 1
        cursor = start + frames_per_slice

    return written, skipped


def _stream_blocks(handle, frames_per_slice: int):
    """Yields fixed-size blocks, discarding the trailing partial slice."""
    while True:
        block = handle.read(frames=frames_per_slice, dtype="float32", always_2d=True)
        if block.shape[0] < frames_per_slice:
            return
        yield block


def iter_audio_files(root: Path, include_mixtures: bool) -> list[Path]:
    """Recursively collects decodable audio, optionally excluding full mixes."""
    found = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTS:
            continue
        if not include_mixtures and path.stem.lower() in MIXTURE_NAMES:
            continue
        found.append(path)
    return found


def run_corpus_mode(args) -> int:
    """Slices an external read-only corpus. Sources are never moved."""
    source = Path(args.source)
    if not source.exists():
        print(f"[ERROR] Source path does not exist: {source}")
        return 1

    if args.output:
        out_dir = Path(args.output)
    elif args.corpus_4s:
        out_dir = CORPUS_4S_DIR / args.genre
    else:
        out_dir = SLICES_DIR / args.genre
    out_dir.mkdir(parents=True, exist_ok=True)

    files = iter_audio_files(source, args.include_mixtures)
    if args.limit:
        files = files[: args.limit]

    print(f"[CORPUS] Source        : {source}")
    print(f"[CORPUS] Destination   : {out_dir}")
    print(f"[CORPUS] Files matched : {len(files)}")
    print(f"[CORPUS] Slice length  : {args.slice_ms} ms")
    print(f"[CORPUS] Skip existing : {args.skip_existing}")
    print(f"[CORPUS] Zero-cross    : {args.zero_cross_ms} ms")
    print(f"[CORPUS] Micro-fade    : {args.fade_ms} ms")
    print(f"[CORPUS] Mixtures      : {'included' if args.include_mixtures else 'excluded'}")
    print("[CORPUS] Sources are read-only and will not be moved.\n")

    if not files:
        print("[INFO] No decodable audio found.")
        return 0

    total_written = total_skipped = failed = 0
    for i, src in enumerate(files, 1):
        try:
            written, skipped = slice_one_file(
                src, out_dir, args.slice_ms, args.silence_floor,
                args.dry_run, dc_block=not args.no_dc_block,
                target_rate=args.target_rate,
                skip_existing=args.skip_existing,
                fade_ms=args.fade_ms,
                zero_cross_ms=args.zero_cross_ms,
            )
            total_written += written
            total_skipped += skipped
            print(f"  [{i}/{len(files)}] {src.parent.name}/{src.name} -> {written} slices ({skipped} silent)", flush=True)
        except Exception as exc:
            failed += 1
            print(f"  [{i}/{len(files)}] [ERROR] {src.name}: {exc}", flush=True)

        if args.target_slices and total_written >= args.target_slices:
            print(f"\n[CORPUS] Reached target of {args.target_slices} slices; stopping early.")
            break

    print("\n================================================================")
    print(f"  Slices written : {total_written}")
    print(f"  Silent skipped : {total_skipped}")
    print(f"  Files failed   : {failed}")
    if args.dry_run:
        print("  MODE           : DRY RUN, nothing was written")
    print("================================================================")
    return 0


def run_queue_mode(args) -> int:
    """Slices incoming/<genre>/ and archives consumed sources."""
    print("================================================================")
    print(f"DATASET INGESTION & {args.slice_ms}MS SLICING ENGINE")
    print("================================================================")

    if not INCOMING_DIR.exists():
        INCOMING_DIR.mkdir(parents=True, exist_ok=True)
        print(f"[SETUP] Created incoming watch directory at {INCOMING_DIR}")
        print("Drop raw audio into genre subfolders, e.g. incoming/heavy_alternative_rock/")
        return 0

    genres = sorted(d.name for d in INCOMING_DIR.iterdir() if d.is_dir())
    if args.genre:
        genres = [g for g in genres if g == args.genre]
        if not genres:
            print(f"[ERROR] Genre folder not found: {INCOMING_DIR / args.genre}")
            return 1

    if not genres:
        print(f"[INFO] No genre subfolders found in {INCOMING_DIR}. Waiting for ingestion assets...")
        return 0

    grand_written = 0
    for genre in genres:
        genre_incoming = INCOMING_DIR / genre
        genre_slices = SLICES_DIR / genre
        genre_archive = ARCHIVE_DIR / genre
        genre_slices.mkdir(parents=True, exist_ok=True)
        genre_archive.mkdir(parents=True, exist_ok=True)

        files = [
            p for p in sorted(genre_incoming.iterdir())
            if p.is_file() and p.suffix.lower() in AUDIO_EXTS
        ]
        if args.limit:
            files = files[: args.limit]
        if not files:
            continue

        print(f"\n[INGEST] Processing genre group: {genre} ({len(files)} files found)")

        for src in files:
            try:
                print(f"  -> Slicing: {src.name}")
                written, skipped = slice_one_file(
                    src, genre_slices, args.slice_ms, args.silence_floor,
                    args.dry_run, dc_block=not args.no_dc_block,
                    target_rate=args.target_rate,
                )
                grand_written += written

                if args.dry_run:
                    print(f"  -> [DRY RUN] Would export {written} slices ({skipped} silent skipped).")
                    continue

                if args.no_archive:
                    print(f"  -> [SUCCESS] Exported {written} slices ({skipped} silent). Source left in place.")
                else:
                    dest = genre_archive / src.name
                    shutil.move(str(src), str(dest))
                    print(f"  -> [SUCCESS] Exported {written} slices ({skipped} silent). Archived to {dest}")

            except Exception as exc:
                print(f"  -> [ERROR] Failed processing {src.name}: {exc}")

    print(f"\n[TOTAL] {grand_written} slices written.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="local_slicer",
        description="Hybrid 1.0 - in-process audio slicing (no ffmpeg subprocess)",
    )
    parser.add_argument("--genre", "-g", default=None,
                        help="Genre slug. Selects incoming/<genre>/ in queue mode; "
                             "names the output folder in corpus mode (required with --source)")
    parser.add_argument("--source", "-s", default=None,
                        help="External read-only corpus root (e.g. D:\\MusicDatasets\\dsd100). "
                             "Sources are never moved.")
    parser.add_argument("--corpus-4s", action="store_true",
                        help="Write 4000ms slices to D:\\MusicDatasets\\corpus_4s\\<genre>\\")
    parser.add_argument("--slice-ms", type=int, default=None,
                        help=f"Slice length in milliseconds (default {DEFAULT_SLICE_MS}, "
                             f"or {CORPUS_4S_MS} with --corpus-4s)")
    parser.add_argument("--silence-floor", type=float, default=DEFAULT_SILENCE_FLOOR_DBFS,
                        help=f"Discard slices quieter than this dBFS (default {DEFAULT_SILENCE_FLOOR_DBFS})")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most N source files")
    parser.add_argument("--target-slices", type=int, default=None,
                        help="Stop once this many slices have been written (corpus mode)")
    parser.add_argument("--include-mixtures", action="store_true",
                        help="Include mixture.wav / mix.wav full mixes (excluded by default)")
    parser.add_argument("--output", "-o", default=None,
                        help="Override the output directory (default uploaded_slices/<genre>/, "
                             "or corpus_4s/<genre>/ with --corpus-4s)")
    parser.add_argument("--target-rate", type=int, default=DEFAULT_TARGET_RATE,
                        help=f"Resample off-rate sources to this rate (default {DEFAULT_TARGET_RATE}). "
                             f"0 keeps each source's native rate.")
    parser.add_argument("--fade-ms", type=float, default=None,
                        help=f"Micro-fade each slice edge (default {DEFAULT_FADE_MS} in corpus mode, 0 in queue mode)")
    parser.add_argument("--zero-cross-ms", type=float, default=None,
                        help=f"Snap slice starts to a nearby zero crossing "
                             f"(default {DEFAULT_ZERO_CROSS_MS} in corpus mode, 0 in queue mode)")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Skip already-written slices and completed sources (implied by --source / --corpus-4s)")
    parser.add_argument("--overwrite", action="store_true",
                        help="Replace existing slice WAVs instead of skipping them")
    parser.add_argument("--no-dc-block", action="store_true",
                        help="Skip the 5 Hz single-pole DC blocker")
    parser.add_argument("--no-archive", action="store_true",
                        help="Queue mode: slice without moving sources to archive/")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be written without creating files")
    return parser


def _resolve_corpus_defaults(args):
    """Fills slice length, fades, and skip-existing for corpus / 4s mode."""
    if args.slice_ms is None:
        args.slice_ms = CORPUS_4S_MS if args.corpus_4s else DEFAULT_SLICE_MS
    if args.fade_ms is None:
        args.fade_ms = DEFAULT_FADE_MS if (args.source or args.corpus_4s) else 0.0
    if args.zero_cross_ms is None:
        args.zero_cross_ms = DEFAULT_ZERO_CROSS_MS if (args.source or args.corpus_4s) else 0.0
    args.skip_existing = (bool(args.source or args.corpus_4s or args.skip_existing)
                          and not args.overwrite)
    return args


def main() -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    args = _resolve_corpus_defaults(build_parser().parse_args())

    if args.corpus_4s and not args.source:
        print("[ERROR] --corpus-4s requires --source (masters are read-only).")
        return 1

    if args.source:
        if not args.genre:
            print("[ERROR] --genre is required with --source; it names the output folder.")
            return 1
        return run_corpus_mode(args)

    return run_queue_mode(args)


if __name__ == "__main__":
    sys.exit(main())
