"""Module 4 — Stem adapter: BPM stretch, key shift, exact section length."""
from __future__ import annotations

from typing import Any, Mapping

import numpy as np

from engine.stem_retriever import bpm_within_tolerance, key_within_tolerance, normalize_key_root

BEATS_PER_BAR = 4.0  # 4/4 default; derive others with song_plan.beats_per_bar()
DEFAULT_SR = 44100
LOOP_JOIN_FADE_MS = 20.0
LOOP_ZC_RADIUS_MS = 15.0


def section_duration_sec(bars: int, bpm: float, *, beats_per_bar: float = BEATS_PER_BAR) -> float:
    tempo = max(1e-6, float(bpm))
    return float(bars) * float(beats_per_bar) * 60.0 / tempo


def section_sample_count(
    bars: int,
    bpm: float,
    sr: int,
    *,
    beats_per_bar: float = BEATS_PER_BAR,
) -> int:
    """Exact length: ``int(round((bars * beats_per_bar * 60 / bpm) * sample_rate))``."""
    return max(1, int(round(section_duration_sec(bars, bpm, beats_per_bar=beats_per_bar) * float(sr))))


def loop_join_fade_samples(sr: int) -> int:
    return max(1, int(round(float(sr) * LOOP_JOIN_FADE_MS / 1000.0)))


def _loop_start(data: np.ndarray, preroll: int, radius: int) -> int:
    """Loop point: a zero-crossing at or after ``preroll`` (within ``2*radius``).

    Starting no earlier than ``preroll`` guarantees real source material
    before the loop point for the centred crossfade.
    """
    from dsp.smart_transient_slicer import find_nearest_zero_crossing

    n = data.shape[0]
    if n <= preroll + 1:
        return min(preroll, max(0, n - 1))
    if radius <= 0:
        return preroll
    zc = find_nearest_zero_crossing(data, preroll + radius, radius)
    return int(zc) if zc is not None and zc >= preroll else preroll


def tile_loop_on_grid(
    audio: np.ndarray,
    target_samples: int,
    *,
    period: int,
    fade: int,
    zc_radius: int = 0,
) -> np.ndarray:
    """Repeat ``audio`` every ``period`` samples with centred equal-power joins.

    The loop point ``s`` is a zero-crossing (searched within ``zc_radius``) with
    ``fade // 2`` samples of real source material before it. Repeat ``k`` puts
    source sample ``s`` exactly at ``k * period`` (grid-locked). Each join is a
    sin/cos equal-power crossfade over ``fade`` samples centred on that onset:
    the outgoing loop's continuation past its period fades out while the
    incoming loop's pre-roll + head fades in, so neither side is truncated
    mid-cycle. The first repeat starts at unity (the section seam handles it).
    """
    data = np.asarray(audio, dtype=np.float64)
    was_1d = data.ndim == 1
    if was_1d:
        data = data[:, np.newaxis]
    total = int(target_samples)
    period = max(1, int(period))
    fade = int(np.clip(int(fade), 0, period))
    half = fade // 2
    fade = 2 * half
    channels = data.shape[1]
    if total <= 0:
        out = np.zeros((0, channels), dtype=np.float64)
        return out[:, 0] if was_1d else out
    start = _loop_start(data, half, zc_radius)
    # body[half] is the loop point; body spans [s - half, s + period + half).
    body = data[start - half : start + period + half]
    if body.shape[0] < period + fade:
        body = np.pad(body, ((0, period + fade - body.shape[0]), (0, 0)))

    out = np.zeros((total + period + fade, channels), dtype=np.float64)
    out[: period + half] = body[half:]
    if fade > 0:
        theta = np.linspace(0.0, 0.5 * np.pi, fade, dtype=np.float64)[:, np.newaxis]
        fade_out = np.cos(theta)
        fade_in = np.sin(theta)
    pos = period
    while pos < total:
        if fade > 0:
            seam = slice(pos - half, pos + half)
            out[seam] = out[seam] * fade_out + body[:fade] * fade_in
            out[pos + half : pos + period + half] = body[fade:]
        else:
            out[pos : pos + period] = body[:period]
        pos += period
    out = out[:total]
    return out[:, 0] if was_1d else out


def enforce_length(
    audio: np.ndarray,
    target_samples: int,
    *,
    loop: bool = False,
    sr: int = DEFAULT_SR,
    loop_period: int | None = None,
) -> np.ndarray:
    """Trim to ``target_samples``; when shorter, zero-pad or (``loop=True``) tile.

    Looping uses 20 ms equal-power joins centred on a zero-crossing loop point
    (see ``tile_loop_on_grid``); raw ``np.tile`` is never used. ``loop_period`` fixes
    the repeat spacing (pass a whole-bar length to stay grid-locked); by default
    the buffer repeats every ``len - fade`` samples.
    """
    data = np.asarray(audio, dtype=np.float64)
    n = int(target_samples)
    if n <= 0:
        return data
    if loop and 0 < data.shape[0] < n:
        fade = loop_join_fade_samples(sr)
        period = int(loop_period) if loop_period else max(1, data.shape[0] - fade)
        zc_radius = max(0, int(round(float(sr) * LOOP_ZC_RADIUS_MS / 1000.0)))
        return tile_loop_on_grid(data, n, period=period, fade=fade, zc_radius=zc_radius)
    if data.ndim == 1:
        if data.shape[0] == n:
            return data
        if data.shape[0] > n:
            return data[:n]
        return np.pad(data, (0, n - data.shape[0]))
    if data.shape[0] == n:
        return data
    if data.shape[0] > n:
        return data[:n]
    return np.pad(data, ((0, n - data.shape[0]), (0, 0)))


def stretch_to_bpm(
    audio: np.ndarray,
    *,
    source_bpm: float | None,
    target_bpm: float,
    sr: int = DEFAULT_SR,
    target_samples: int | None = None,
) -> np.ndarray:
    """Pitch-neutral time-stretch toward ``target_bpm`` (WSOLA / lock helper)."""
    from dsp.tempo_time_stretch import lock_slice_to_tempo, time_stretch_wsola, fold_bpm_octave, clip_stretch_rate

    data = np.asarray(audio, dtype=np.float64)
    if data.size == 0 or float(target_bpm) <= 0:
        return data
    src = float(source_bpm) if source_bpm and float(source_bpm) > 0 else float(target_bpm)
    if target_samples is not None:
        return lock_slice_to_tempo(
            data,
            target_bpm=float(target_bpm),
            sr=int(sr),
            target_samples=int(target_samples),
            original_bpm=src,
        )
    folded = fold_bpm_octave(src, float(target_bpm))
    rate = float(target_bpm) / folded if folded > 1e-6 else 1.0
    rate = clip_stretch_rate(rate)
    return time_stretch_wsola(data, rate_multiplier=rate, sr=int(sr))


def pitch_shift_to_key(
    audio: np.ndarray,
    *,
    source_key: str | None,
    target_key: str | None,
    sr: int = DEFAULT_SR,
    semitones: int | None = None,
) -> tuple[np.ndarray, int]:
    """Pitch-shift by calculated (or provided) semitone offset. Returns (audio, shift)."""
    if semitones is None:
        ok, shift = key_within_tolerance(source_key, target_key, max_semitones=12)
        _ = ok
    else:
        shift = int(semitones)
    if shift == 0:
        return np.asarray(audio, dtype=np.float64), 0
    from dsp.pitch_key_aligner import pitch_shift_slice

    return pitch_shift_slice(np.asarray(audio, dtype=np.float64), float(shift), sr=int(sr)), int(shift)


class StemAdapter:
    """Adapt a retrieved buffer to the song-plan tempo, key, and bar length."""

    def __init__(self, sr: int = DEFAULT_SR, *, beats_per_bar: float = BEATS_PER_BAR) -> None:
        self.sr = int(sr)
        self.beats_per_bar = float(beats_per_bar)

    def target_length(self, bars: int, bpm: float) -> int:
        return section_sample_count(bars, bpm, self.sr, beats_per_bar=self.beats_per_bar)

    def adapt(
        self,
        audio: np.ndarray,
        *,
        bars: int,
        target_bpm: float,
        target_key: str | None,
        source_bpm: float | None = None,
        source_key: str | None = None,
        pitch_shift_semitones: int | None = None,
        metadata: Mapping[str, Any] | None = None,
        extra_samples: int = 0,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        """Stretch → pitch-shift → loop to the exact section sample count.

        Output length is ``target_length(bars, bpm) + extra_samples``. Slices
        shorter than that are tiled in whole bars (zero-crossing joins), never
        padded with trailing silence. ``extra_samples`` renders material past
        the final barline for the assembler's section crossfade to consume.
        """
        meta = dict(metadata or {})
        src_bpm = source_bpm if source_bpm is not None else meta.get("estimated_bpm")
        src_key = source_key if source_key is not None else meta.get("detected_key")
        shift = pitch_shift_semitones
        if shift is None and "pitch_shift_semitones" in meta:
            shift = int(meta["pitch_shift_semitones"])

        target_n = self.target_length(int(bars), float(target_bpm))
        # Rate-lock to the UI BPM (112-native → 89). Do not pad to target_n
        # here — lock_slice_to_tempo zero-pads, which would tile silence.
        # enforce_length below loops the stretched audio onto the bar grid.
        stretched = stretch_to_bpm(
            audio,
            source_bpm=float(src_bpm) if src_bpm else None,
            target_bpm=float(target_bpm),
            sr=self.sr,
            target_samples=None,
        )
        shifted, applied = pitch_shift_to_key(
            stretched,
            source_key=str(src_key) if src_key else None,
            target_key=target_key,
            sr=self.sr,
            semitones=shift,
        )
        total_n = target_n + max(0, int(extra_samples))
        bar_n = self.target_length(1, float(target_bpm))
        fade = loop_join_fade_samples(self.sr)
        zc_radius = max(0, int(round(self.sr * LOOP_ZC_RADIUS_MS / 1000.0)))
        # Whole bars that fit in the slice with room for the centred join
        # (pre-roll + continuation) and the zero-crossing search window.
        usable = int(np.asarray(shifted).shape[0]) - fade - 2 * zc_radius
        loop_bars = int(np.clip(usable // bar_n, 1, max(1, int(bars))))
        out = enforce_length(
            shifted,
            total_n,
            loop=True,
            sr=self.sr,
            loop_period=self.target_length(loop_bars, float(target_bpm)),
        )
        info = {
            "target_samples": target_n,
            "rendered_samples": total_n,
            "loop_bars": loop_bars if np.asarray(shifted).shape[0] < total_n else None,
            "source_bpm": float(src_bpm) if src_bpm else None,
            "target_bpm": float(target_bpm),
            "source_key": normalize_key_root(str(src_key) if src_key else None),
            "target_key": normalize_key_root(target_key),
            "pitch_shift_semitones": int(applied),
            "bpm_within_8pct": bpm_within_tolerance(
                float(src_bpm) if src_bpm else float(target_bpm),
                float(target_bpm),
            ),
        }
        return out, info
