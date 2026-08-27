#!/usr/bin/env python3
"""WAV -> 320k MP3 / 256k AAC with optional ID3 and MP4 tags."""
from __future__ import annotations

import os
import subprocess
from typing import Optional

from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TALB, TBPM, TIT2, TPE1
from mutagen.mp4 import MP4, MP4Cover

DEFAULT_COVER = "/workspace/assets/default_cover.jpg"


def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        tail = err[-4000:] if err else f"exit {result.returncode}"
        raise RuntimeError(f"ffmpeg failed ({' '.join(cmd[:6])} ...): {tail}")


def _mime_for_cover(path: str) -> str:
    lower = path.lower()
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    return "image/png"


def resolve_cover_image_path(cover_image_path: Optional[str] = None) -> Optional[str]:
    candidates = []
    if cover_image_path:
        candidates.append(cover_image_path)
    candidates.append(DEFAULT_COVER)
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def embed_mp3_metadata(
    mp3_path: str,
    title: str,
    artist: str,
    album: str,
    bpm: float,
    cover_image_path: Optional[str] = None,
) -> None:
    try:
        audio = ID3(mp3_path)
    except ID3NoHeaderError:
        audio = ID3()

    audio.delall("TIT2")
    audio.delall("TPE1")
    audio.delall("TALB")
    audio.delall("TBPM")
    audio.add(TIT2(encoding=3, text=title))
    audio.add(TPE1(encoding=3, text=artist))
    audio.add(TALB(encoding=3, text=album))
    audio.add(TBPM(encoding=3, text=str(int(round(bpm)))))

    cover = resolve_cover_image_path(cover_image_path)
    if cover:
        audio.delall("APIC")
        with open(cover, "rb") as img:
            audio.add(
                APIC(
                    encoding=3,
                    mime=_mime_for_cover(cover),
                    type=3,
                    desc="Cover",
                    data=img.read(),
                )
            )
    audio.save(mp3_path, v2_version=4)


def embed_m4a_metadata(
    m4a_path: str,
    title: str,
    artist: str,
    album: str,
    bpm: float,
    cover_image_path: Optional[str] = None,
) -> None:
    audio = MP4(m4a_path)
    audio["\xa9nam"] = title
    audio["\xa9ART"] = artist
    audio["\xa9alb"] = album
    audio["tmpo"] = [int(round(bpm))]

    cover = resolve_cover_image_path(cover_image_path)
    if cover:
        with open(cover, "rb") as img:
            image_format = (
                MP4Cover.FORMAT_JPEG
                if cover.lower().endswith((".jpg", ".jpeg"))
                else MP4Cover.FORMAT_PNG
            )
            audio["covr"] = [MP4Cover(img.read(), imageformat=image_format)]
    audio.save()


def transcode_and_tag(
    source_wav_path: str,
    title: str = "Automated Render",
    artist: str = "Hybrid AI Engine",
    album: str = "Generated Sessions",
    bpm: float = 120.0,
    cover_image_path: Optional[str] = None,
) -> dict:
    if not os.path.isfile(source_wav_path):
        raise FileNotFoundError(source_wav_path)

    base_path, _ = os.path.splitext(source_wav_path)
    mp3_path = f"{base_path}.mp3"
    aac_path = f"{base_path}.m4a"

    _run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-i",
            source_wav_path,
            "-map_metadata",
            "0",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "320k",
            "-ar",
            "44100",
            "-joint_stereo",
            "1",
            mp3_path,
        ]
    )
    _run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-i",
            source_wav_path,
            "-map_metadata",
            "0",
            "-codec:a",
            "aac",
            "-b:a",
            "256k",
            "-ar",
            "44100",
            aac_path,
        ]
    )

    embed_mp3_metadata(mp3_path, title, artist, album, bpm, cover_image_path)
    embed_m4a_metadata(aac_path, title, artist, album, bpm, cover_image_path)
    return {
        "wav": source_wav_path,
        "mp3": mp3_path,
        "aac": aac_path,
    }


def transcode_master_formats(source_wav_path: str) -> dict:
    return transcode_and_tag(source_wav_path)
