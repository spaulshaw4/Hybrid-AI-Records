"""Bar-level energy arc and DSP state machine (producer automation).

Replaces per-section SQL restitching: lock a band once, then drive the same
stems with an energy curve that scales to any ``total_bars``.
"""
from __future__ import annotations

from typing import Any, Mapping, MutableMapping

import numpy as np

from engine.dsp_utils import (
    align_length,
    as_frames,
    highpass,
    lowpass,
    restore_shape,
    split_crossover,
)
from engine.hybrid_conductor import AdaptiveConductor
from engine.relational_mixer import detect_low_onsets

ENERGY_MIN = 1.0
ENERGY_MAX = 10.0
KICK_MUTE_HZ = 180.0
KICK_BODY_SEC = 0.14
SWELL_GAIN = float(10.0 ** (1.5 / 20.0))
BAR_BLEND_SEC = 0.012

RHYTHM_FILTER_HZ: dict[str, float] = {
    "lowpass_400Hz": 400.0,
    "lowpass_600Hz": 600.0,
    "lowpass_1000Hz": 1000.0,
    "lowpass_2000Hz": 2000.0,
}


def generate_energy_arc(total_bars: int, *, seed: int | None = None) -> np.ndarray:
    """Proportional 1–10 energy curve for any track length.

    Acts: intro 10%, build 20%, peak 30%, drop 15%, climax 20%, outro 5%.
    ±1 human variation every 4 bars (seeded) so short and long songs share
    the same shape instead of hardcoded verse/chorus tables.
    """
    bars = max(1, int(total_bars))
    arc = np.zeros(bars, dtype=np.float64)

    intro_end = int(bars * 0.10)
    build_end = intro_end + int(bars * 0.20)
    peak_end = build_end + int(bars * 0.30)
    drop_end = peak_end + int(bars * 0.15)
    climax_end = drop_end + int(bars * 0.20)

    arc[0:intro_end] = 2
    arc[intro_end:build_end] = 5
    arc[build_end:peak_end] = 8
    arc[peak_end:drop_end] = 3
    arc[drop_end:climax_end] = 10
    arc[climax_end:] = 1

    rng = np.random.default_rng(None if seed is None else int(seed))
    for i in range(0, bars, 4):
        arc[i : i + 4] += float(rng.choice([-1, 0, 1]))

    return np.clip(arc, ENERGY_MIN, ENERGY_MAX)


def apply_dsp_rules(energy_level: float) -> dict[str, Any]:
    """Map energy (1–10) or tension (1–100) to mixing-console commands."""
    level = float(energy_level)
    if level > 10.0:
        rules = AdaptiveConductor(1).evaluate_dsp_rules(level)
        rules["energy"] = level / 10.0
        return rules
    rules: dict[str, Any] = {
        "drums_active": True,
        "kick_muted": False,
        "bass_active": True,
        "rhythm_filter": None,
        "rhythm_swell": False,
        "lead_active": False,
        "stereo_width": 1.0,
        "energy": level,
    }

    if level <= 2:
        rules["drums_active"] = False
        rules["bass_active"] = False
        rules["rhythm_filter"] = "lowpass_400Hz"
        rules["stereo_width"] = 0.5
    elif level <= 4:
        rules["kick_muted"] = True
        rules["bass_active"] = False
        rules["rhythm_filter"] = "lowpass_1000Hz"
        rules["stereo_width"] = 0.8
    elif level <= 6:
        rules["rhythm_filter"] = None
        rules["lead_active"] = False
        rules["stereo_width"] = 0.8
    elif level <= 8:
        rules["lead_active"] = True
    else:
        rules["lead_active"] = True
        rules["rhythm_swell"] = True
        rules["stereo_width"] = 1.25

    return rules


def energy_to_unit(energy_10: float) -> float:
    """Producer 1–10 scale → ``SectionPlan.energy_level`` 0–1."""
    return float(np.clip(float(energy_10) / ENERGY_MAX, 0.0, 1.0))


def rhythm_filter_hz(rules: Mapping[str, Any]) -> float | None:
    freq = rules.get("lowpass_freq")
    if freq is not None:
        try:
            return float(freq)
        except (TypeError, ValueError):
            pass
    token = rules.get("rhythm_filter")
    if not token:
        return None
    if isinstance(token, (int, float)):
        return float(token)
    known = RHYTHM_FILTER_HZ.get(str(token))
    if known:
        return known
    digits = "".join(ch for ch in str(token) if ch.isdigit())
    return float(digits) if digits else None


def mute_kick_on_beat_one(
    drums: np.ndarray,
    sr: int,
    bpm: float,
    *,
    beats_per_bar: float = 4.0,
) -> np.ndarray:
    """Transient-slice the bar and mute kick body (low band) on beat 1 only."""
    frames, was_1d = as_frames(np.asarray(drums, dtype=np.float64))
    n = int(frames.shape[0])
    if n == 0 or sr <= 0:
        return restore_shape(frames, was_1d)

    beat_samples = max(1, int(round(60.0 / max(1e-6, float(bpm)) * float(sr))))
    beat1_window = max(beat_samples // 3, int(0.04 * float(sr)))
    body = max(8, int(round(KICK_BODY_SEC * float(sr))))
    onsets = detect_low_onsets(restore_shape(frames, True), int(sr))

    windows: list[tuple[int, int]] = []
    for onset in onsets.tolist() if onsets.size else []:
        if abs(int(onset) - 0) <= beat1_window:
            lo = max(0, int(onset) - int(0.008 * float(sr)))
            hi = min(n, int(onset) + body)
            windows.append((lo, hi))
    if not windows:
        windows.append((0, min(n, body)))

    out = restore_shape(frames.copy(), False)
    for lo, hi in windows:
        chunk = out[lo:hi]
        if chunk.size == 0:
            continue
        # Mute kick body on beat 1: high-pass the transient window.
        out[lo:hi] = as_frames(highpass(chunk, int(sr), KICK_MUTE_HZ, order=4))[0]
        low, high = split_crossover(out[lo:hi], int(sr), KICK_MUTE_HZ)
        low_f, _ = as_frames(align_length(low, hi - lo))
        high_f, _ = as_frames(align_length(high, hi - lo))
        out[lo:hi] = high_f
        _ = low_f
    _ = beats_per_bar
    return restore_shape(out, was_1d, frames.dtype)


def apply_stereo_width(audio_array: np.ndarray, width_factor: float) -> np.ndarray:
    """Mid/side width. Mono upmixes to dual-mono when ``width_factor != 1``."""
    audio_array = np.asarray(audio_array, dtype=np.float64)
    width_factor = float(width_factor)
    if audio_array.size == 0:
        return audio_array

    # Channel-first (ch, n) from the executive snippet.
    if audio_array.ndim == 2 and audio_array.shape[0] in (1, 2) and audio_array.shape[1] > 2:
        if audio_array.shape[0] == 1:
            if width_factor == 1.0:
                return audio_array
            audio_array = np.vstack((audio_array, audio_array))
        left, right = audio_array[0], audio_array[1]
        mid = (left + right) / 2.0
        side = (left - right) / 2.0
        return np.array(
            [mid + (side * width_factor), mid - (side * width_factor)]
        )

    frames, was_1d = as_frames(audio_array)
    # 1. Catch mono stems and upmix to dual-mono safely
    if frames.shape[1] < 2:
        if width_factor == 1.0:
            return restore_shape(frames, was_1d)
        frames = np.repeat(frames, 2, axis=1)
    # 2. Apply Mid/Side widening to the stereo matrix
    left, right = frames[:, 0], frames[:, 1]
    mid = (left + right) / 2.0
    side = (left - right) / 2.0
    new_left = mid + (side * width_factor)
    new_right = mid - (side * width_factor)
    return np.column_stack((new_left, new_right))


def _bus_rms(audio: np.ndarray) -> float:
    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(arr * arr)))


def cross_adapt_balance(
    stems: dict[str, np.ndarray],
    rules: Mapping[str, Any],
) -> dict[str, np.ndarray]:
    """Context-aware balance: stems listen to each other inside one bar."""
    out = dict(stems)
    rhythm_rms = _bus_rms(out.get("rhythm", np.zeros(0)))
    harmonic_rms = _bus_rms(out.get("harmonic", np.zeros(0)))
    bass_rms = _bus_rms(out.get("bass", np.zeros(0)))
    if (
        rules.get("drums_active")
        and rhythm_rms > 1e-6
        and harmonic_rms > rhythm_rms * 1.35
        and "harmonic" in out
    ):
        out["harmonic"] = np.asarray(out["harmonic"], dtype=np.float64) * (
            rhythm_rms / (harmonic_rms + 1e-9)
        )
    if (
        rules.get("bass_active")
        and rules.get("drums_active")
        and rhythm_rms > 1e-6
        and 0.0 < bass_rms < rhythm_rms * 0.35
        and "bass" in out
    ):
        out["bass"] = np.asarray(out["bass"], dtype=np.float64) * min(
            1.8, rhythm_rms * 0.55 / (bass_rms + 1e-9)
        )
    return out


def apply_bar_dsp(
    dry: Mapping[str, np.ndarray],
    rules: Mapping[str, Any],
    sr: int,
    bpm: float,
    *,
    beats_per_bar: float = 4.0,
) -> dict[str, np.ndarray]:
    """Apply one bar of console rules to dry (unlocked) band stems."""
    out: dict[str, np.ndarray] = {}
    cutoff = rhythm_filter_hz(rules)
    drums_active = bool(rules.get("drums_active", True)) and not rules.get("drums_muted")
    bass_active = bool(rules.get("bass_active", True)) and not rules.get("bass_muted")

    for bus, audio in dry.items():
        frames, was_1d = as_frames(np.asarray(audio, dtype=np.float64))
        processed = restore_shape(frames, False)

        if bus == "rhythm":
            if rules.get("kick_muted") and drums_active:
                processed = mute_kick_on_beat_one(
                    processed, sr, bpm, beats_per_bar=beats_per_bar
                )
            if not drums_active:
                processed = np.zeros_like(np.asarray(processed, dtype=np.float64))
        elif bus == "bass":
            if not bass_active:
                processed = np.zeros_like(np.asarray(processed, dtype=np.float64))
        elif bus == "harmonic":
            if cutoff:
                processed = lowpass(processed, int(sr), float(cutoff), order=4)
            if rules.get("rhythm_swell"):
                processed = np.asarray(processed, dtype=np.float64) * SWELL_GAIN
        elif bus == "lead":
            if not rules.get("lead_active"):
                processed = np.zeros_like(np.asarray(processed, dtype=np.float64))

        gain = float((rules.get("volume") or {}).get(bus, 1.0))
        if bus == "rhythm" and not drums_active:
            gain = 0.0
        if bus == "bass" and not bass_active:
            gain = 0.0
        processed = np.asarray(processed, dtype=np.float64) * float(np.clip(gain, 0.0, 2.0))
        frames_out, _ = as_frames(processed)
        out[bus] = restore_shape(frames_out, was_1d)

    width = float(rules.get("stereo_width") or 1.0)
    if abs(width - 1.0) > 1e-6:
        for bus in ("rhythm", "harmonic", "lead", "vocal"):
            if bus in out:
                out[bus] = apply_stereo_width(out[bus], width)
    return cross_adapt_balance(out, rules)


def blend_bar_into(
    dest: MutableMapping[str, np.ndarray],
    bar: Mapping[str, np.ndarray],
    start: int,
    end: int,
    *,
    sr: int,
    fade_sec: float = BAR_BLEND_SEC,
) -> None:
    """Write a processed bar into the master buffers with a short equal-gain seam."""
    fade = min(max(0, end - start) // 2, max(1, int(round(float(fade_sec) * float(sr)))))
    for bus, audio in bar.items():
        if bus not in dest:
            continue
        frames, _ = as_frames(np.asarray(audio, dtype=np.float64))
        target = dest[bus]
        tgt, was_1d = as_frames(target)
        width = min(frames.shape[1], tgt.shape[1])
        sl = tgt[start:end, :width]
        src = frames[: sl.shape[0], :width]
        if sl.shape[0] == 0:
            continue
        if start > 0 and fade > 0 and sl.shape[0] > fade:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float64)[:, np.newaxis]
            sl[:fade] = sl[:fade] * (1.0 - ramp) + src[:fade] * ramp
            sl[fade:] = src[fade:]
        else:
            sl[:] = src
        dest[bus] = restore_shape(tgt, was_1d)


def filter_stems_for_rules(stems: list[str], rules: Mapping[str, Any]) -> list[str]:
    """Drop muted families from an ``active_stems`` list."""
    kept: list[str] = []
    for stem in stems:
        key = str(stem).strip().lower()
        if key in {"drums", "drum", "percussion", "rhythm"} and not rules.get("drums_active", True):
            continue
        if key == "bass" and not rules.get("bass_active", True):
            continue
        if key in {"lead_guitar", "lead", "solo", "synth_lead"} and not rules.get("lead_active"):
            continue
        kept.append(stem)
    if not kept:
        kept = ["rhythm_guitar"]
    return kept
