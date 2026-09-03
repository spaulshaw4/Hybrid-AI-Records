"""Inject BWF bext + RIFF INFO (including ISRC) without rewriting PCM samples."""
from __future__ import annotations

import argparse
import os
import re
import struct
import sys
import tempfile
from datetime import datetime, timezone

ISRC_PATTERN = re.compile(r"^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$")


def _ascii_pad(text: str, width: int) -> bytes:
    return text.encode("ascii", errors="replace").ljust(width, b"\x00")[:width]


def normalise_isrc(raw: str) -> str:
    compact = re.sub(r"[^A-Za-z0-9]", "", raw).upper()
    if len(compact) != 12:
        raise ValueError(f"ISRC must be 12 characters: {raw}")
    pretty = f"{compact[:2]}-{compact[2:5]}-{compact[5:7]}-{compact[7:]}"
    if not ISRC_PATTERN.match(pretty):
        raise ValueError(f"Invalid ISRC: {raw}")
    return pretty


def _iter_chunks(blob: bytes) -> list[tuple[bytes, bytes]]:
    chunks: list[tuple[bytes, bytes]] = []
    pos = 12
    while pos + 8 <= len(blob):
        cid = blob[pos : pos + 4]
        size = struct.unpack_from("<I", blob, pos + 4)[0]
        start = pos + 8
        end = start + size
        if end > len(blob):
            raise ValueError("WAV chunk overruns file")
        chunks.append((cid, blob[start:end]))
        pos = end + (size % 2)
    return chunks


def pack_chunk(cid: bytes, payload: bytes) -> bytes:
    odd = len(payload) % 2
    return cid + struct.pack("<I", len(payload)) + payload + (b"\x00" if odd else b"")


def make_info_tag(tag: bytes, text: str) -> bytes:
    payload = text.encode("utf-8") + b"\x00"
    return pack_chunk(tag, payload)


def build_bext(artist: str, isrc: str, true_peak_dbtp: float) -> bytes:
    now = datetime.now(timezone.utc)
    description = _ascii_pad(f"Mastered via Hybrid AI Engine | Peak: {true_peak_dbtp:.2f} dBTP", 256)
    originator = _ascii_pad(artist, 32)
    originator_ref = _ascii_pad(isrc, 32)
    payload = (
        description
        + originator
        + originator_ref
        + now.strftime("%Y-%m-%d").encode("ascii")
        + now.strftime("%H:%M:%S").encode("ascii")
        + b"\x00" * 8
        + b"\x01\x00"
        + b"\x00" * 64
        + b"\x00" * 190
    )
    if len(payload) != 602:
        raise RuntimeError(f"bext payload must be 602 bytes, got {len(payload)}")
    return pack_chunk(b"bext", payload)


def build_info_list(title: str, artist: str, genre: str, isrc: str, true_peak_dbtp: float) -> bytes:
    inner = (
        make_info_tag(b"INAM", title)
        + make_info_tag(b"IART", artist)
        + make_info_tag(b"IGNR", genre)
        + make_info_tag(b"ISRC", isrc)
        + make_info_tag(b"ICMT", f"True Peak: {true_peak_dbtp:.2f} dBTP | Phase Aligned")
    )
    return pack_chunk(b"LIST", b"INFO" + inner)


def inject_bwf_metadata(
    wav_path: str,
    title: str,
    artist: str,
    isrc: str,
    genre: str,
    true_peak_dbtp: float,
) -> None:
    if not os.path.isfile(wav_path):
        raise FileNotFoundError(wav_path)
    isrc = normalise_isrc(isrc)
    with open(wav_path, "rb") as handle:
        data = handle.read()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"Invalid WAV container: {wav_path}")

    kept: list[bytes] = []
    data_seen = False
    bext = build_bext(artist, isrc, true_peak_dbtp)
    info = build_info_list(title, artist, genre, isrc, true_peak_dbtp)
    inserted = False

    for cid, payload in _iter_chunks(data):
        if cid == b"bext":
            continue
        if cid == b"LIST" and payload[:4] == b"INFO":
            continue
        packed = pack_chunk(cid, payload)
        if cid == b"data" and not inserted:
            kept.append(bext)
            kept.append(info)
            inserted = True
            data_seen = True
        kept.append(packed)

    if not inserted:
        kept.extend((bext, info))

    payload = b"".join(kept)
    riff = b"RIFF" + struct.pack("<I", len(payload) + 4) + b"WAVE" + payload
    directory = os.path.dirname(os.path.abspath(wav_path)) or "."
    fd, tmp = tempfile.mkstemp(suffix=".wav", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(riff)
        os.replace(tmp, wav_path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    print(f"[TAGGED] BWF & ISRC metadata injected into: {wav_path}")
    if not data_seen:
        print("[WARN] No data chunk found; metadata appended after existing chunks.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--artist", default="Hybrid AI Records")
    parser.add_argument("--isrc", default="US-HAI-26-00001")
    parser.add_argument("--genre", required=True)
    parser.add_argument("--true-peak", type=float, required=True)
    args = parser.parse_args()
    try:
        inject_bwf_metadata(args.input, args.title, args.artist, args.isrc, args.genre, args.true_peak)
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
