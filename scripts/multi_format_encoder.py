"""Transcode a 24-bit PCM master to FLAC, 320k MP3, and 256k AAC.

Library functions raise or return a status dict. Only the CLI exits.

Lossy path (MP3 / AAC)
----------------------
24-bit masters are reduced to 16-bit with TPDF dither (ffmpeg
``dither_method=triangular_hp``, then ``triangular`` if needed) and a
True Peak *ceiling guard* of approximately −0.50 dBTP.

``alimiter=limit=0.9441`` is 10**(−0.50/20) and is a cheap peak clamp,
not a full ITU-R BS.1770 true-peak meter. If ``alimiter`` is missing from
this ffmpeg build, the fallback is ``volume=-0.5dB``. ``loudnorm`` is not
used — it is two-pass and heavier than a delivery encode needs.

FLAC stays 24-bit and is not dithered (lossless). The ceiling guard is
lossy-only so the archival FLAC remains a transparent copy of the PCM.

ffmpeg is resolved from ``FFMPEG_BIN`` / ``FFMPEG``, then
``C:\\ffmpeg\\bin\\ffmpeg.exe``, then ``ffmpeg`` on PATH. Missing binary
fails the whole run; a single target encode error continues the others
and the CLI returns non-zero if any target failed.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from typing import Iterable

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from audio_metadata_tagger import normalise_isrc  # noqa: E402

TRUE_PEAK_CEILING_DBTP = -0.50
# 10 ** (-0.50 / 20.0) ≈ 0.94406087
ALIMITER_LIMIT = 0.9441
LOSSY_BITRATE = {"mp3": "320k", "aac": "256k"}
DEFAULT_TARGETS = ("flac", "mp3", "aac")
WINDOWS_FFMPEG = r"C:\ffmpeg\bin\ffmpeg.exe"
_FILTER_CACHE: dict[str, set[str]] | None = None
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


class FfmpegMissingError(RuntimeError):
    """Raised when no ffmpeg binary can be resolved."""


def resolve_ffmpeg_bin() -> str | None:
    """Return an ffmpeg executable path, or None if nothing usable exists."""
    for env_name in ("FFMPEG_BIN", "FFMPEG", "FFMPEG_PATH", "FFMPEG_BINARY"):
        raw = (os.environ.get(env_name) or "").strip().strip('"')
        if not raw:
            continue
        if os.path.isfile(raw):
            return raw
        found = shutil.which(raw)
        if found:
            return found
    if os.path.isfile(WINDOWS_FFMPEG):
        return WINDOWS_FFMPEG
    return shutil.which("ffmpeg")


def require_ffmpeg() -> str:
    path = resolve_ffmpeg_bin()
    if not path:
        raise FfmpegMissingError(
            "ffmpeg not found. Set FFMPEG_BIN or FFMPEG, install to "
            r"C:\ffmpeg\bin\ffmpeg.exe, or put ffmpeg on PATH."
        )
    return path


def sanitize_ffmpeg_metadata(value: str, limit: int = 512) -> str:
    """Strip control chars and `=` so `-metadata key=value` stays one token."""
    text = _CONTROL_CHARS.sub(" ", str(value)).replace("\ufeff", "")
    text = text.replace("=", "-").replace("\\", "/")
    text = re.sub(r"\s+", " ", text).strip()
    if text.startswith("-"):
        text = text.lstrip("-").strip()
    return text[:limit]


def inspect_wav(path: str) -> dict:
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    with wave.open(path, "rb") as handle:
        return {
            "channels": handle.getnchannels(),
            "sampwidth": handle.getsampwidth(),
            "framerate": handle.getframerate(),
            "nframes": handle.getnframes(),
            "comptype": handle.getcomptype(),
        }


def _probe_filter_names(ffmpeg: str) -> set[str]:
    global _FILTER_CACHE
    if _FILTER_CACHE is not None and ffmpeg in _FILTER_CACHE:
        return _FILTER_CACHE[ffmpeg]
    names: set[str] = set()
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        blob = f"{proc.stdout or ''}\n{proc.stderr or ''}"
        for name in ("alimiter", "aresample", "volume", "aformat", "loudnorm"):
            if re.search(rf"\b{name}\b", blob):
                names.add(name)
    except (OSError, subprocess.TimeoutExpired):
        names = set()
    if _FILTER_CACHE is None:
        _FILTER_CACHE = {}
    _FILTER_CACHE[ffmpeg] = names
    return names


def lossy_filter_candidates(ffmpeg: str) -> list[tuple[str, str]]:
    """Ordered (filter_graph, note) pairs, most capable first.

    Ceiling is applied on the 24-bit stream, then TPDF dither on the 16-bit
    downsample. soxr is preferred when the build has it; encode retries drop
    it if the filter graph is rejected.
    """
    names = _probe_filter_names(ffmpeg)
    if "alimiter" in names:
        ceiling = f"alimiter=limit={ALIMITER_LIMIT}:level=false"
        ceiling_note = (
            f"alimiter limit={ALIMITER_LIMIT} ~= {TRUE_PEAK_CEILING_DBTP:.2f} dBTP "
            "(peak clamp, not a full ITU true-peak meter)"
        )
    else:
        ceiling = f"volume={TRUE_PEAK_CEILING_DBTP}dB"
        ceiling_note = (
            f"volume={TRUE_PEAK_CEILING_DBTP}dB "
            "(alimiter not listed by this ffmpeg; conservative sample-peak pad)"
        )

    candidates: list[tuple[str, str]] = []
    if "aresample" in names:
        candidates.append(
            (
                f"{ceiling},aresample=resampler=soxr:precision=28:osf=s16:dither_method=triangular_hp",
                f"{ceiling_note}; TPDF triangular_hp via soxr aresample (24-bit to 16-bit)",
            )
        )
        candidates.append(
            (
                f"{ceiling},aresample=osf=s16:dither_method=triangular_hp",
                f"{ceiling_note}; TPDF triangular_hp via aresample (24-bit to 16-bit)",
            )
        )
        candidates.append(
            (
                f"{ceiling},aresample=osf=s16:dither_method=triangular",
                f"{ceiling_note}; TPDF triangular via aresample (24-bit to 16-bit)",
            )
        )
    candidates.append((ceiling, f"{ceiling_note}; encoder default quantization"))
    return candidates


def _metadata_args(title: str, artist: str, genre: str | None, isrc: str | None) -> list[str]:
    args = [
        "-metadata",
        f"title={sanitize_ffmpeg_metadata(title)}",
        "-metadata",
        f"artist={sanitize_ffmpeg_metadata(artist)}",
    ]
    if genre:
        args.extend(["-metadata", f"genre={sanitize_ffmpeg_metadata(genre)}"])
    if isrc:
        compact = re.sub(r"[^A-Za-z0-9]", "", isrc)
        args.extend(["-metadata", f"ISRC={compact}"])
        args.extend(["-metadata", f"TSRC={compact}"])
    return args


def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        tail = err[-4000:] if err else f"exit {result.returncode}"
        raise RuntimeError(f"ffmpeg failed ({' '.join(cmd[:8])} ...): {tail}")


def _atomic_encode(ffmpeg: str, dest: str, extra_args: Iterable[str], input_path: str) -> None:
    directory = os.path.dirname(os.path.abspath(dest)) or "."
    os.makedirs(directory, exist_ok=True)
    suffix = os.path.splitext(dest)[1] or ".bin"
    fd, tmp = tempfile.mkstemp(prefix=".enc_", suffix=suffix, dir=directory)
    os.close(fd)
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", input_path, *extra_args, tmp]
    try:
        _run_ffmpeg(cmd)
        os.replace(tmp, dest)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def _encode_flac(ffmpeg: str, src: str, dest: str, meta: list[str]) -> str:
    extra = [
        "-map_metadata",
        "0",
        *meta,
        "-c:a",
        "flac",
        "-compression_level",
        "8",
        "-sample_fmt",
        "s32",
    ]
    _atomic_encode(ffmpeg, dest, extra, src)
    return "FLAC 24-bit (no dither; lossless copy of the PCM master)"


def _encode_lossy(
    ffmpeg: str,
    src: str,
    dest: str,
    meta: list[str],
    codec: str,
    bitrate: str,
) -> str:
    last_error: Exception | None = None
    used_note = ""
    for graph, note in lossy_filter_candidates(ffmpeg):
        extra = [
            "-map_metadata",
            "0",
            *meta,
            "-af",
            graph,
            "-c:a",
            codec,
            "-b:a",
            bitrate,
            "-ar",
            "44100",
        ]
        if codec == "libmp3lame":
            extra.extend(["-joint_stereo", "1", "-write_id3v2", "1"])
        try:
            _atomic_encode(ffmpeg, dest, extra, src)
            used_note = note
            last_error = None
            break
        except RuntimeError as exc:
            last_error = exc
            continue
    if last_error is not None:
        raise last_error
    return used_note


def encode_master_formats(
    input_wav: str,
    title: str,
    artist: str = "Hybrid AI Records",
    genre: str | None = None,
    isrc: str | None = None,
    out_dir: str | None = None,
    targets: Iterable[str] = DEFAULT_TARGETS,
    ffmpeg_bin: str | None = None,
) -> dict:
    """Encode selected targets. Never calls sys.exit.

    Returns ``{ok, ffmpeg, outputs, failed, warnings, notes}``.
    Missing ffmpeg raises ``FfmpegMissingError`` (fail-fast).
    """
    wav_info = inspect_wav(input_wav)
    warnings: list[str] = []
    if wav_info["comptype"] not in ("NONE", "not compressed", ""):
        warnings.append(f"container compression is {wav_info['comptype']!r}; expected uncompressed PCM")
    if wav_info["sampwidth"] != 3:
        warnings.append(
            f"sample width is {wav_info['sampwidth'] * 8}-bit, not 24-bit; encode continues"
        )

    ffmpeg = ffmpeg_bin or require_ffmpeg()
    pretty_isrc = None
    if isrc:
        pretty_isrc = normalise_isrc(isrc)

    meta = _metadata_args(title, artist, genre, pretty_isrc)
    stem = os.path.splitext(os.path.basename(input_wav))[0]
    dest_dir = out_dir or os.path.dirname(os.path.abspath(input_wav)) or "."
    os.makedirs(dest_dir, exist_ok=True)

    wanted = [item.strip().lower() for item in targets if item and item.strip()]
    if not wanted:
        raise ValueError("no encode targets requested")

    outputs: dict[str, str] = {}
    failed: dict[str, str] = {}
    notes: list[str] = []

    for target in wanted:
        if target == "flac":
            dest = os.path.join(dest_dir, f"{stem}.flac")
            try:
                notes.append(_encode_flac(ffmpeg, input_wav, dest, meta))
                outputs["flac"] = dest
            except Exception as exc:
                failed["flac"] = str(exc)
        elif target == "mp3":
            dest = os.path.join(dest_dir, f"{stem}.mp3")
            try:
                notes.append(
                    _encode_lossy(ffmpeg, input_wav, dest, meta, "libmp3lame", LOSSY_BITRATE["mp3"])
                )
                outputs["mp3"] = dest
            except Exception as exc:
                failed["mp3"] = str(exc)
        elif target in ("aac", "m4a"):
            dest = os.path.join(dest_dir, f"{stem}.m4a")
            try:
                notes.append(_encode_lossy(ffmpeg, input_wav, dest, meta, "aac", LOSSY_BITRATE["aac"]))
                outputs["aac"] = dest
            except Exception as exc:
                failed["aac"] = str(exc)
        else:
            failed[target] = f"unknown target {target!r} (expected flac, mp3, aac)"

    return {
        "ok": not failed,
        "ffmpeg": ffmpeg,
        "input": os.path.abspath(input_wav),
        "wav": wav_info,
        "outputs": outputs,
        "failed": failed,
        "warnings": warnings,
        "notes": list(dict.fromkeys(notes)),
        "title": sanitize_ffmpeg_metadata(title),
        "artist": sanitize_ffmpeg_metadata(artist),
        "genre": sanitize_ffmpeg_metadata(genre) if genre else None,
        "isrc": pretty_isrc,
    }


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser(
        description=(
            "Transcode a 24-bit PCM master to FLAC (lossless), 320k MP3, and 256k AAC. "
            "Lossy encodes use TPDF dither (24-bit to 16-bit) and a -0.50 dBTP ceiling guard."
        )
    )
    parser.add_argument("-i", "--input", required=True, help="24-bit PCM WAV master")
    parser.add_argument("--title", required=True)
    parser.add_argument("--artist", default="Hybrid AI Records")
    parser.add_argument("--genre", default=None)
    parser.add_argument("--isrc", default=None, help="Optional 12-character ISRC")
    parser.add_argument("--out-dir", default=None, help="Destination directory (default: beside the WAV)")
    parser.add_argument(
        "--targets",
        default="flac,mp3,aac",
        help="Comma-separated subset of flac,mp3,aac",
    )
    args = parser.parse_args(argv)

    try:
        ffmpeg = require_ffmpeg()
    except FfmpegMissingError as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 1

    targets = [part.strip() for part in args.targets.split(",") if part.strip()]
    try:
        report = encode_master_formats(
            args.input,
            title=args.title,
            artist=args.artist,
            genre=args.genre,
            isrc=args.isrc,
            out_dir=args.out_dir,
            targets=targets,
            ffmpeg_bin=ffmpeg,
        )
    except FileNotFoundError as exc:
        print(f"[ERROR] missing input: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    except wave.Error as exc:
        print(f"[ERROR] not a readable WAV: {exc}", file=sys.stderr)
        return 1

    print(f"[FFMPEG] {report['ffmpeg']}")
    bits = report["wav"]["sampwidth"] * 8
    print(
        f"[SOURCE] {report['input']}  {report['wav']['framerate']} Hz  "
        f"{report['wav']['channels']} ch  {bits}-bit"
    )
    for warning in report["warnings"]:
        print(f"[WARN] {warning}")
    for note in report["notes"]:
        print(f"[DSP] {note}")
    for name, path in report["outputs"].items():
        print(f"[OK] {name}: {path}")
    for name, err in report["failed"].items():
        print(f"[FAIL] {name}: {err}", file=sys.stderr)
    if report["ok"]:
        print("[ENCODE COMPLETE] all requested targets wrote successfully.")
        return 0
    print("[ENCODE INCOMPLETE] one or more targets failed.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
