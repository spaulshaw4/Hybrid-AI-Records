"""Recorded-voice ingest: WebM/Opus → WAV, loudness, and mix-bus ducking.

Chrome MediaRecorder emits ``audio/webm;codecs=opus``. ``soundfile`` cannot
read that container. This module transcodes through FFmpeg to 44.1 kHz
16-bit stereo PCM, then trims leading silence, high-passes rumble, and
normalizes to −14 LUFS so the take can sit on the master bus.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from engine.dsp_utils import (
    EPS,
    align_length,
    as_frames,
    envelope_follower,
    highpass,
    restore_shape,
    rms_dbfs,
    split_mid_band,
    to_mono,
)

VOCAL_TARGET_LUFS = -14.0
VOCAL_HPF_HZ = 80.0
VOCAL_ACTIVE_RMS_DB = -40.0
VOCAL_DUCK_DB = 2.5
VOCAL_DUCK_LOW_HZ = 1000.0
VOCAL_DUCK_HIGH_HZ = 4000.0
VOCAL_OUTRO_BARS = 8
MIN_SONG_SEC = 60.0
MAX_SONG_SEC = 420.0
LEAD_SILENCE_DB = -50.0
DEFAULT_SR = 44100


def bars_for_duration(seconds: float, bpm: float) -> int:
    """4/4 bars: ``round(seconds * bpm / 240)``."""
    tempo = max(1.0, float(bpm))
    return max(4, min(256, int(round(float(seconds) * tempo / 240.0))))


def song_length_from_vocal(vocal_sec: float, bpm: float, *, outro_bars: int = VOCAL_OUTRO_BARS) -> float:
    """Instrumental length = vocal take + ``outro_bars`` (default 8)."""
    bar_sec = 240.0 / max(1.0, float(bpm))
    raw = float(vocal_sec) + float(outro_bars) * bar_sec
    return float(max(MIN_SONG_SEC, min(MAX_SONG_SEC, raw)))


def clamp_song_duration(seconds: float | None, default: float = 210.0) -> float:
    if seconds is None or not np.isfinite(float(seconds)):
        return float(default)
    return float(max(MIN_SONG_SEC, min(MAX_SONG_SEC, float(seconds))))


def ffmpeg_bin() -> str | None:
    for name in ("ffmpeg", "ffmpeg.exe"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _is_riff_wav(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(4) == b"RIFF"
    except OSError:
        return False


def transcode_vocal_to_wav(input_path: str | Path, *, sr: int = DEFAULT_SR) -> Path:
    """Convert any container (WebM/Opus, m4a, wav) to 44.1 kHz stereo PCM WAV."""
    src = Path(input_path)
    dest = src.with_name(f"{src.stem}_44100.wav") if src.suffix.lower() != ".wav" or not _is_riff_wav(src) else src
    if dest == src and _is_riff_wav(src):
        return src
    binary = ffmpeg_bin()
    if binary is None:
        if _is_riff_wav(src):
            return src
        raise RuntimeError(
            "FFmpeg is required to transcode Chrome WebM/Opus vocal takes. "
            "Install ffmpeg and ensure it is on PATH."
        )
    cmd = [
        binary, "-y",
        "-i", str(src),
        "-ar", str(int(sr)),
        "-ac", "2",
        "-c:a", "pcm_s16le",
        str(dest),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0 or not dest.is_file():
        detail = (result.stderr or result.stdout or "").strip()[-400:]
        raise RuntimeError(f"FFmpeg vocal transcode failed: {detail}")
    return dest


def persist_uploaded_vocal(
    raw: bytes,
    filename: str,
    dest_dir: str | Path,
    *,
    sr: int = DEFAULT_SR,
) -> str:
    """Write the browser blob, transcode to WAV, return the WAV path."""
    folder = Path(dest_dir)
    folder.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in (filename or "vocal.webm"))
    raw_path = folder / f"raw_{uuid.uuid4().hex[:10]}_{safe}"
    raw_path.write_bytes(raw)
    print(
        f"[VOICE INGEST] saved {raw_path.name} bytes={len(raw)} suffix={raw_path.suffix}",
        flush=True,
    )
    wav_path = transcode_vocal_to_wav(raw_path, sr=sr)
    print(f"[VOICE INGEST] Successfully transcoded to: {wav_path}", flush=True)
    return str(wav_path)


def duration_from_vocal_file(path: str | Path) -> float:
    import soundfile as sf

    if not path or not os.path.isfile(str(path)):
        return 0.0
    info = sf.info(str(path))
    if not info.samplerate:
        return 0.0
    return float(info.frames) / float(info.samplerate)


def trim_leading_silence(audio: np.ndarray, sr: int, *, thresh_db: float = LEAD_SILENCE_DB) -> np.ndarray:
    frames, was_1d = as_frames(audio)
    if frames.size == 0 or sr <= 0:
        return restore_shape(frames, was_1d)
    mono = to_mono(frames)
    win = max(1, int(round(0.02 * float(sr))))
    n = mono.size
    hop = max(1, win // 2)
    start = 0
    floor = 10.0 ** (float(thresh_db) / 20.0)
    for i in range(0, n, hop):
        chunk = mono[i : i + win]
        if chunk.size == 0:
            break
        if float(np.sqrt(np.mean(chunk * chunk) + EPS)) >= floor:
            start = max(0, i - hop)
            break
    return restore_shape(frames[start:], was_1d, frames.dtype)


def normalize_to_lufs(audio: np.ndarray, sr: int, *, target_lufs: float = VOCAL_TARGET_LUFS) -> np.ndarray:
    from engine.song_evaluator import measure_integrated_lufs

    data = np.asarray(audio, dtype=np.float64)
    current = measure_integrated_lufs(data, int(sr))
    if not np.isfinite(current) or current <= -70.0:
        return data
    gain = 10.0 ** ((float(target_lufs) - float(current)) / 20.0)
    gained = data * gain
    peak = float(np.max(np.abs(gained))) if gained.size else 0.0
    if peak > 0.98:
        gained = gained * (0.98 / peak)
    return gained


def load_and_prepare_vocal(path: str | Path, sr: int = DEFAULT_SR) -> np.ndarray:
    """Load a take, trim leading silence, HPF 80 Hz, normalize to −14 LUFS."""
    import soundfile as sf

    audio, file_sr = sf.read(str(path), always_2d=True)
    audio = np.asarray(audio, dtype=np.float64)
    use_sr = int(file_sr or sr)
    if use_sr != int(sr) and audio.size:
        # Cheap linear resample so the mix bus stays on the session rate.
        n_src = audio.shape[0]
        n_dst = max(1, int(round(n_src * float(sr) / float(use_sr))))
        t_src = np.linspace(0.0, 1.0, n_src, endpoint=False)
        t_dst = np.linspace(0.0, 1.0, n_dst, endpoint=False)
        resampled = np.column_stack(
            [np.interp(t_dst, t_src, audio[:, ch]) for ch in range(audio.shape[1])]
        )
        audio = resampled
        use_sr = int(sr)
    audio = trim_leading_silence(audio, use_sr)
    audio = highpass(audio, use_sr, VOCAL_HPF_HZ, order=2)
    audio = normalize_to_lufs(audio, use_sr, target_lufs=VOCAL_TARGET_LUFS)
    print(
        f"[VOICE] prepared frames={audio.shape[0]} sr={use_sr} "
        f"rms={rms_dbfs(audio):.1f} dBFS",
        flush=True,
    )
    return np.asarray(audio, dtype=np.float64)


def vocal_activity_gain(vocal: np.ndarray, sr: int, n: int) -> np.ndarray:
    """0..1 envelope: 1 when vocal RMS is above −40 dB."""
    if vocal is None or np.asarray(vocal).size == 0 or n <= 0:
        return np.zeros(max(0, n), dtype=np.float64)
    mono = to_mono(align_length(np.asarray(vocal, dtype=np.float64), n))
    env = envelope_follower(mono, int(sr), attack_ms=12.0, release_ms=180.0)
    if env.size != n:
        env = align_length(env, n)
    floor = 10.0 ** (VOCAL_ACTIVE_RMS_DB / 20.0)
    peak = float(np.max(env)) if env.size else 0.0
    if peak < EPS:
        return np.zeros(n, dtype=np.float64)
    amount = np.clip(env / (peak + EPS), 0.0, 1.0)
    active = (env >= floor).astype(np.float64)
    return np.clip(amount * active, 0.0, 1.0)


def duck_mix_mids_for_vocal(
    mix: np.ndarray,
    vocal: np.ndarray,
    sr: int,
    *,
    duck_db: float = VOCAL_DUCK_DB,
) -> np.ndarray:
    """Dip 1–4 kHz on the instrumental mix by ``duck_db`` while the voice is up."""
    frames, was_1d = as_frames(mix)
    n = frames.shape[0]
    if n == 0:
        return restore_shape(frames, was_1d)
    activity = vocal_activity_gain(vocal, sr, n)
    if float(np.max(activity)) < 1e-4:
        return restore_shape(frames, was_1d, frames.dtype)
    floor = 10.0 ** (-abs(float(duck_db)) / 20.0)
    gain = 1.0 - activity * (1.0 - floor)
    low, mid, high = split_mid_band(
        restore_shape(frames, False), sr, VOCAL_DUCK_LOW_HZ, VOCAL_DUCK_HIGH_HZ
    )
    mid_f, _ = as_frames(align_length(mid, n))
    low_f, _ = as_frames(align_length(low, n))
    high_f, _ = as_frames(align_length(high, n))
    ducked = low_f + mid_f * gain[:, np.newaxis] + high_f
    return restore_shape(ducked, was_1d, frames.dtype)


def overlay_vocal_on_mix(mix: np.ndarray, vocal: np.ndarray) -> np.ndarray:
    """Sum the prepared vocal onto the (already ducked) instrumental mix."""
    mix_f, was_1d = as_frames(mix)
    voc_f, _ = as_frames(vocal)
    n = mix_f.shape[0]
    if n == 0 or voc_f.size == 0:
        return restore_shape(mix_f, was_1d)
    voc_f = as_frames(align_length(voc_f, n))[0]
    if voc_f.shape[1] == 1 and mix_f.shape[1] > 1:
        voc_f = np.repeat(voc_f, mix_f.shape[1], axis=1)
    elif voc_f.shape[1] > mix_f.shape[1]:
        voc_f = voc_f[:, : mix_f.shape[1]]
    elif voc_f.shape[1] < mix_f.shape[1]:
        voc_f = np.pad(voc_f, ((0, 0), (0, mix_f.shape[1] - voc_f.shape[1])))
    return restore_shape(mix_f + voc_f, was_1d, mix_f.dtype)


def mix_recorded_vocal_onto_master(
    mix_path: str,
    vocal_path: str,
    *,
    sr: int = DEFAULT_SR,
) -> dict[str, Any]:
    """Load mix + vocal, duck mids, overlay voice, overwrite ``mix_path``."""
    import soundfile as sf

    mix, mix_sr = sf.read(mix_path, always_2d=True)
    use_sr = int(mix_sr or sr)
    vocal = load_and_prepare_vocal(vocal_path, use_sr)
    ducked = duck_mix_mids_for_vocal(mix, vocal, use_sr)
    out = overlay_vocal_on_mix(ducked, vocal)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0.98:
        out = out * (0.98 / peak)
    sf.write(mix_path, np.asarray(out, dtype=np.float64), use_sr, subtype="PCM_24")
    meta = {
        "vocal_present": True,
        "vocal_sec": round(vocal.shape[0] / float(use_sr), 3) if vocal.size else 0.0,
        "mix_sec": round(out.shape[0] / float(use_sr), 3),
        "duck_db": VOCAL_DUCK_DB,
    }
    print(
        f"[VOICE] mixed onto master vocal_sec={meta['vocal_sec']:.2f} "
        f"mix_sec={meta['mix_sec']:.2f} duck={VOCAL_DUCK_DB} dB @ 1-4 kHz",
        flush=True,
    )
    return meta
