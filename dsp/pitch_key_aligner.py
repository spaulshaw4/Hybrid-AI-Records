"""Detect slice key via chroma and pitch-shift to a target root.

Chroma and pitch-shift are numpy/scipy first. Librosa is optional and only
imported behind try/except when HYBRID_USE_LIBROSA=1 — the workstation stack
(numba/soxr) has been unreliable.
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTE_MAP = {
    "C": "C",
    "C#": "C#",
    "DB": "C#",
    "D": "D",
    "D#": "D#",
    "EB": "D#",
    "E": "E",
    "E#": "F",
    "FB": "E",
    "F": "F",
    "F#": "F#",
    "GB": "F#",
    "G": "G",
    "G#": "G#",
    "AB": "G#",
    "A": "A",
    "A#": "A#",
    "BB": "A#",
    "B": "B",
    "B#": "C",
    "CB": "B",
}
_FLAT_ALIASES = {key: value for key, value in NOTE_MAP.items() if key != value}
_QUIET_PEAK = 1e-6
_QUIET_RMS = 1e-5
_NOOP_SEMITONES = 0.05


def _as_frames(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio)
    if data.ndim == 1:
        return np.column_stack((data, data))
    if data.shape[-1] == 1:
        return np.column_stack((data[..., 0], data[..., 0]))
    return data


def _mono(audio: np.ndarray) -> np.ndarray:
    return np.mean(_as_frames(audio), axis=1)


def _is_quiet(mono: np.ndarray) -> bool:
    if mono.size == 0:
        return True
    peak = float(np.max(np.abs(mono)))
    if peak < _QUIET_PEAK:
        return True
    rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))
    return rms < _QUIET_RMS


def _optional_librosa():
    flag = os.environ.get("HYBRID_USE_LIBROSA", "").strip().lower()
    if flag not in {"1", "true", "yes"}:
        return None
    try:
        import librosa

        return librosa
    except Exception:
        return None


def normalise_root_note(note: str) -> str:
    token = note.strip().upper().replace("♭", "B").replace("♯", "#")
    token = NOTE_MAP.get(token, _FLAT_ALIASES.get(token, token))
    if token not in NOTE_NAMES:
        raise ValueError(f"Unknown root note: {note}")
    return token


def _chroma_stft(mono: np.ndarray, sr: int) -> np.ndarray:
    """12-bin chroma via STFT magnitude mapped onto pitch-class bins."""
    n_fft = 4096
    hop = 2048
    window = np.hanning(n_fft)
    chroma = np.zeros(12, dtype=np.float64)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    valid = (freqs >= 50.0) & (freqs <= 5000.0)
    midi = np.zeros_like(freqs)
    safe = np.maximum(freqs[valid], 1e-12)
    midi[valid] = 69.0 + 12.0 * np.log2(safe / 440.0)
    pc = np.mod(np.round(midi), 12).astype(np.int64)
    if len(mono) < n_fft:
        frames = [np.pad(mono, (0, n_fft - len(mono)))]
    else:
        frames = [mono[i : i + n_fft] for i in range(0, len(mono) - n_fft + 1, hop)]
    for frame in frames:
        spec = np.abs(np.fft.rfft(frame * window[: len(frame)]))
        np.add.at(chroma, pc[valid], spec[valid])
    return chroma


def _dominant_chroma_index(chroma: np.ndarray) -> int | None:
    chroma = np.asarray(chroma, dtype=np.float64).reshape(-1)
    if chroma.size != 12:
        return None
    total = float(np.sum(chroma))
    peak = float(np.max(chroma))
    if total < 1e-10 or peak < 1e-10:
        return None
    median = float(np.median(chroma))
    if median > 0.0 and peak < median * 2.5:
        return None
    if peak / total < 0.12:
        return None
    return int(np.argmax(chroma))


def detect_slice_key(audio_mono: np.ndarray, sr: int = 44100) -> tuple[int, str]:
    mono = np.asarray(audio_mono, dtype=np.float64)
    if mono.ndim > 1:
        mono = _mono(mono)
    chroma = _chroma_stft(mono, sr)
    librosa = _optional_librosa()
    if librosa is not None:
        try:
            chroma = np.mean(librosa.feature.chroma_cqt(y=mono, sr=sr), axis=1)
        except Exception:
            pass
    dominant = _dominant_chroma_index(chroma)
    if dominant is None:
        dominant = int(np.argmax(chroma)) if chroma.size else 0
    dominant = int(dominant) % 12
    return dominant, NOTE_NAMES[dominant]


def shortest_semitone_delta(current_idx: int, target_idx: int) -> int:
    """Shortest wrap onto [-6, +5]."""
    return (int(target_idx) - int(current_idx) + 6) % 12 - 6


def calculate_semitone_shift(source_key: str, target_key: str) -> int:
    """Shortest chromatic shift from source root to target root, wrapped to [-6, +5]."""
    if not source_key or not target_key:
        return 0
    src = normalise_root_note(source_key)
    tgt = normalise_root_note(target_key)
    if src == tgt:
        return 0
    return shortest_semitone_delta(NOTE_NAMES.index(src), NOTE_NAMES.index(tgt))


def _pitch_shift_resample(channel: np.ndarray, semitones: float) -> np.ndarray:
    from scipy.signal import resample

    ratio = 2.0 ** (semitones / 12.0)
    new_len = max(1, int(round(len(channel) / ratio)))
    shifted = resample(channel, new_len)
    return resample(shifted, len(channel))


def _pitch_shift_phase_vocoder(channel: np.ndarray, semitones: float, sr: int) -> np.ndarray:
    """STFT bin-shift phase vocoder; pad/trim to the original length."""
    from scipy.signal import istft, stft

    nperseg = 2048
    noverlap = 1536
    _freqs, _times, zxx = stft(channel, fs=sr, nperseg=nperseg, noverlap=noverlap)
    ratio = 2.0 ** (semitones / 12.0)
    n_bins = zxx.shape[0]
    src = np.round(np.arange(n_bins) / ratio).astype(np.int64)
    shifted = np.zeros_like(zxx)
    valid = (src >= 0) & (src < n_bins)
    shifted[valid] = zxx[src[valid]]
    _t, y = istft(shifted, fs=sr, nperseg=nperseg, noverlap=noverlap)
    if len(y) < len(channel):
        y = np.pad(y, (0, len(channel) - len(y)))
    return y[: len(channel)]


def pitch_shift_slice(audio: np.ndarray, semitones: float, sr: int = 44100) -> np.ndarray:
    if abs(float(semitones)) < _NOOP_SEMITONES:
        return audio
    frames = _as_frames(audio)
    librosa = _optional_librosa()
    shifted_channels = []
    for ch in range(frames.shape[1]):
        y = np.asarray(frames[:, ch], dtype=np.float64)
        shifted = None
        if librosa is not None:
            try:
                shifted = librosa.effects.pitch_shift(y, sr=sr, n_steps=semitones, bins_per_octave=12)
            except Exception:
                shifted = None
        if shifted is None:
            try:
                shifted = _pitch_shift_phase_vocoder(y, semitones, sr)
            except Exception:
                shifted = _pitch_shift_resample(y, semitones)
        if len(shifted) < len(y):
            shifted = np.pad(shifted, (0, len(y) - len(shifted)), mode="edge")
        else:
            shifted = shifted[: len(y)]
        shifted_channels.append(shifted)
    out = np.column_stack(shifted_channels)
    source = np.asarray(audio)
    if source.ndim == 1:
        return out[:, 0].astype(source.dtype, copy=False)
    return out.astype(source.dtype, copy=False)


def align_slice_to_target_key(
    audio: np.ndarray,
    target_root: str | None = "A",
    sr: int = 44100,
    target_root_note: str | None = None,
    detected_key: str | None = None,
) -> np.ndarray:
    """Pitch-shift a mono or stereo slice so its dominant root matches ``target_root``.

    Quiet or no-chroma audio is returned unchanged. ``target_root_note`` is kept
    as a keyword alias for older callers. ``detected_key`` skips chroma detection.
    """
    if np.asarray(audio).size == 0:
        return audio
    root = target_root_note if target_root_note is not None else target_root
    if root is None or not str(root).strip():
        return audio
    target_note = normalise_root_note(root)
    target_idx = NOTE_NAMES.index(target_note)
    if detected_key:
        current_note = normalise_root_note(detected_key)
        current_idx = NOTE_NAMES.index(current_note)
    else:
        mono = _mono(audio)
        if _is_quiet(mono):
            return audio
        chroma = _chroma_stft(mono, sr)
        current_idx = _dominant_chroma_index(chroma)
        if current_idx is None:
            return audio
        current_note = NOTE_NAMES[current_idx]
    delta = shortest_semitone_delta(current_idx, target_idx)
    if delta == 0:
        return audio
    print(f"    [PITCH ALIGN] Shifting {current_note} -> {target_note} ({delta:+} semitones)")
    return pitch_shift_slice(audio, float(delta), sr=sr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Align a slice to a target root key")
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("-k", "--key", default="A")
    args = parser.parse_args()
    try:
        import soundfile as sf
    except ImportError:
        print("[ERROR] soundfile is required for CLI use", file=sys.stderr)
        sys.exit(1)
    data, sample_rate = sf.read(args.input, always_2d=True)
    aligned = align_slice_to_target_key(data, target_root=args.key, sr=sample_rate)
    sf.write(args.output, aligned, sample_rate, subtype="PCM_24")
