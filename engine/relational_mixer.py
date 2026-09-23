"""Stem Interaction & Relational DSP Engine (Module 2).

Replaces blind stem summing with relational rules driven by ``SectionPlan`` /
``MixIntents`` from the Global Song Plan:

* Kick -> bass low-end ducking (< 120 Hz)
* Vocal / solo pocketing (1.0-3.5 kHz dip on harmonic competitors)
* Shared-room reverb (one IR, per-bus wet returns — no cross-stem bleed)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, MutableMapping, Sequence

import numpy as np

from engine.dsp_utils import (
    EPS,
    align_length,
    as_frames,
    bandpass,
    convolve_reverb,
    db_to_lin,
    envelope_follower,
    peak_dbfs,
    restore_shape,
    rms_dbfs,
    split_crossover,
    split_mid_band,
    synthesize_impulse,
    to_mono,
)
from engine.song_plan import MixIntents, SectionPlan

# Bus names used by the arranged 4-bus assembler.
ARRANGE_BUSES = ("rhythm", "bass", "harmonic", "vocal")
# Optional melodic-lead bus (lead guitar / synth lead) from ArrangementAssembler.
LEAD_BUS = "lead"
MIX_BUSES = ARRANGE_BUSES + (LEAD_BUS,)
REVERB_BUSES = ("rhythm", "harmonic", "vocal", LEAD_BUS)
# Section active_stems names that request the 1.0-3.5 kHz pocket on the
# harmonic bed: a vocal, or a lead melodic line.
VOCAL_STEM_NAMES = frozenset({"vocal", "vocals", "lead_vocal", "vox"})
LEAD_STEM_NAMES = frozenset({"lead_guitar", "synth_lead", "solo", "lead"})
SECTION_XFADE_MS = 20.0
# Pre-roll processed before each section window so filters / envelopes settle.
SECTION_WARMUP_MS = 250.0

DEFAULT_SIDECHAIN_DB = (2.0, 5.0)  # min/max duck depth
DEFAULT_POCKET_DB = (2.0, 3.0)
DEFAULT_REVERB_SEND = (0.10, 0.25)
SIDECHAIN_LP_HZ = 120.0
POCKET_LOW_HZ = 1000.0
POCKET_HIGH_HZ = 3500.0
SIDECHAIN_ATTACK_MS = 5.0
SIDECHAIN_RELEASE_MS = 80.0
POCKET_ATTACK_MS = 8.0
POCKET_RELEASE_MS = 120.0
VOCAL_GATE = 1e-3


@dataclass
class RelationalMixResult:
    stems: dict[str, np.ndarray]
    mix: np.ndarray
    meters: dict[str, Any] = field(default_factory=dict)


def _empty_like(ref: np.ndarray) -> np.ndarray:
    frames, was_1d = as_frames(ref)
    z = np.zeros_like(frames)
    return restore_shape(z, was_1d)


def _clip(value: float, lo: float, hi: float) -> float:
    return float(max(lo, min(hi, value)))


def _mix_intents_from_mapping(raw: Mapping[str, Any] | MixIntents | None) -> MixIntents:
    if isinstance(raw, MixIntents):
        return raw
    if not raw:
        return MixIntents()
    try:
        return MixIntents.model_validate(dict(raw))
    except Exception as exc:
        print(f"[RELATIONAL] invalid mix_intents, using defaults: {exc}", flush=True)
        return MixIntents()


def _section_energy(section: SectionPlan | Mapping[str, Any] | None) -> float:
    if section is None:
        return 0.55
    if isinstance(section, SectionPlan):
        return float(section.energy_level)
    try:
        return float(section.get("energy_level") or section.get("energy") or 0.55)
    except (TypeError, ValueError):
        return 0.55


def _active_stems(section: SectionPlan | Mapping[str, Any] | None) -> set[str]:
    if section is None:
        return set()
    if isinstance(section, SectionPlan):
        return {str(s).lower() for s in section.active_stems}
    stems = section.get("active_stems") if isinstance(section, Mapping) else None
    if not stems:
        return set()
    return {str(s).lower() for s in stems}


class RelationalMixer:
    """Relational processor: stems listen to each other before the final sum."""

    def __init__(
        self,
        sr: int = 44100,
        *,
        mix_intents: MixIntents | Mapping[str, Any] | None = None,
        section: SectionPlan | Mapping[str, Any] | None = None,
        impulse: np.ndarray | None = None,
    ) -> None:
        self.sr = int(sr)
        self.mix_intents = _mix_intents_from_mapping(mix_intents)
        self.section = section
        self._impulse = (
            np.asarray(impulse, dtype=np.float64)
            if impulse is not None
            else synthesize_impulse(self.sr, decay_sec=1.15)
        )

    def sidechain_duck_bass(
        self,
        bass: np.ndarray,
        rhythm: np.ndarray,
        *,
        duck_db: float | None = None,
    ) -> np.ndarray:
        """Duck bass energy below 120 Hz from kick/rhythm transients."""
        if bass is None or np.asarray(bass).size == 0:
            return bass
        if rhythm is None or np.asarray(rhythm).size == 0:
            return bass

        frames, was_1d = as_frames(bass)
        n = frames.shape[0]
        rhythm_a = align_length(np.asarray(rhythm), n)

        # Detector: lowpassed rhythm envelope (kick body), 5 ms / 80 ms.
        kick_band = bandpass(rhythm_a, self.sr, 40.0, SIDECHAIN_LP_HZ)
        env = envelope_follower(
            kick_band,
            self.sr,
            attack_ms=SIDECHAIN_ATTACK_MS,
            release_ms=SIDECHAIN_RELEASE_MS,
        )
        peak = float(np.max(env)) if env.size else 0.0
        if peak < EPS:
            return restore_shape(frames, was_1d)

        depth = duck_db if duck_db is not None else self._sidechain_db()
        floor = db_to_lin(-abs(depth))
        amount = np.clip(env / (peak + EPS), 0.0, 1.0)
        gain = np.clip(1.0 - amount * (1.0 - floor), floor, 1.0)

        low, high = split_crossover(restore_shape(frames, was_1d), self.sr, SIDECHAIN_LP_HZ)
        low_f, _ = as_frames(align_length(low, n))
        high_f, _ = as_frames(align_length(high, n))
        ducked_low = low_f * gain[:, np.newaxis]
        out = ducked_low + high_f
        return restore_shape(out, was_1d, frames.dtype)

    def vocal_pocket(
        self,
        harmonic: np.ndarray,
        vocal: np.ndarray | None,
        *,
        cut_db: float | None = None,
    ) -> np.ndarray:
        """Dip 1.0-3.5 kHz on harmonic when vocal / solo mid energy is present.

        Non-destructive: missing or silent vocal returns ``harmonic`` unchanged.
        """
        if harmonic is None or np.asarray(harmonic).size == 0:
            return harmonic
        if vocal is None or np.asarray(vocal).size == 0:
            return harmonic

        frames, was_1d = as_frames(harmonic)
        n = frames.shape[0]
        vocal_a = align_length(np.asarray(vocal), n)
        detector = bandpass(vocal_a, self.sr, POCKET_LOW_HZ, POCKET_HIGH_HZ)
        env = envelope_follower(
            detector,
            self.sr,
            attack_ms=POCKET_ATTACK_MS,
            release_ms=POCKET_RELEASE_MS,
        )
        peak = float(np.max(env)) if env.size else 0.0
        if peak < VOCAL_GATE:
            return restore_shape(frames, was_1d)

        depth = cut_db if cut_db is not None else self._pocket_db()
        floor = db_to_lin(-abs(depth))
        amount = np.clip(env / (peak + EPS), 0.0, 1.0)
        gain = np.clip(1.0 - amount * (1.0 - floor), floor, 1.0)

        low, mid, high = split_mid_band(
            restore_shape(frames, was_1d), self.sr, POCKET_LOW_HZ, POCKET_HIGH_HZ
        )
        mid_f, _ = as_frames(align_length(mid, n))
        low_f, _ = as_frames(align_length(low, n))
        high_f, _ = as_frames(align_length(high, n))
        mid_ducked = mid_f * gain[:, np.newaxis]
        out = low_f + mid_ducked + high_f
        return restore_shape(out, was_1d, frames.dtype)

    def coherence_reverb(
        self,
        stems: Mapping[str, np.ndarray],
        *,
        send: float | None = None,
        buses: Sequence[str] = REVERB_BUSES,
    ) -> dict[str, np.ndarray]:
        """Shared-room reverb: one impulse response, convolved per bus.

        Every active bus is convolved with the same IR (a coherent "shared
        room") and its own wet return is added back to that bus only, so no
        stem carries another stem's reverb. Each wet return is scaled::

            wet = convolve(bus) * (send / sqrt(N)) * 0.25

        With N uncorrelated per-bus returns the summed wet power stays
        constant as N grows. Tails decay naturally past the dry signal.
        """
        wet_send = send if send is not None else self._reverb_send()
        wet_send = _clip(wet_send, DEFAULT_REVERB_SEND[0], DEFAULT_REVERB_SEND[1])
        if wet_send <= 0.0:
            return {k: np.asarray(v) for k, v in stems.items()}

        out: dict[str, np.ndarray] = {k: np.asarray(v, dtype=np.float64) for k, v in stems.items()}
        active: list[str] = []
        for bus in buses:
            audio = out.get(bus)
            if audio is None or np.asarray(audio).size == 0:
                continue
            if rms_dbfs(audio) < -70.0:
                continue
            active.append(bus)
        n_stems = len(active)
        if n_stems == 0:
            return out

        scale = float(wet_send) / float(np.sqrt(n_stems)) * 0.25
        for bus in active:
            frames, was_1d = as_frames(out[bus])
            # wet=1.0 returns the fully wet path, RMS-matched to this bus's dry.
            wet = np.asarray(
                convolve_reverb(to_mono(frames), self._impulse, wet=1.0),
                dtype=np.float64,
            ) * scale
            out[bus] = restore_shape(
                frames + wet[:, np.newaxis],
                was_1d,
                frames.dtype,
            )
        return out

    def mix(
        self,
        stems: Mapping[str, np.ndarray],
        *,
        section: SectionPlan | Mapping[str, Any] | None = None,
        apply_reverb: bool = True,
    ) -> RelationalMixResult:
        """Relational rules for one window (``apply_reverb=False`` for per-section use)."""
        return self.process(stems, section=section, apply_reverb=apply_reverb)

    def process(
        self,
        stems: Mapping[str, np.ndarray],
        *,
        section: SectionPlan | Mapping[str, Any] | None = None,
        apply_reverb: bool = True,
    ) -> RelationalMixResult:
        """Apply relational rules and return processed stems + summed master.

        Order: kick→bass duck, 1.0-3.5 kHz pocket on the harmonic bed (keyed
        by vocal and/or lead bus), carve make-up gain, then (optionally) the
        shared-room reverb.
        """
        section = section if section is not None else self.section
        energy = _section_energy(section)
        active = _active_stems(section)

        working: MutableMapping[str, np.ndarray] = {}
        ref_len = 0
        ref_ch = 1
        for bus in MIX_BUSES:
            audio = stems.get(bus)
            if audio is None:
                continue
            arr = np.asarray(audio)
            if arr.size == 0:
                working[bus] = arr
                continue
            frames, was_1d = as_frames(arr)
            ref_len = max(ref_len, frames.shape[0])
            ref_ch = max(ref_ch, frames.shape[1])
            working[bus] = restore_shape(frames, was_1d)

        # Normalize lengths for safe summing.
        for bus, audio in list(working.items()):
            if np.asarray(audio).size == 0:
                continue
            working[bus] = align_length(audio, ref_len)

        # Linear RMS snapshots for post-carve auto-makeup (before ducking/EQ).
        pre_rms_lin: dict[str, float] = {}
        for bus, audio in working.items():
            if audio is None or np.asarray(audio).size == 0:
                continue
            arr = np.asarray(audio, dtype=np.float64)
            pre_rms_lin[bus] = float(np.sqrt(np.mean(arr * arr)) + 1e-9)

        meters: dict[str, Any] = {
            "sidechain_applied": False,
            "vocal_pocket_applied": False,
            "reverb_send": 0.0,
            "section_energy": energy,
            "reverb_n_stems": 0,
        }

        rhythm = working.get("rhythm")
        bass = working.get("bass")
        if (
            rhythm is not None
            and bass is not None
            and np.asarray(rhythm).size
            and np.asarray(bass).size
        ):
            # Always try sidechain when both buses exist; section may omit names.
            working["bass"] = self.sidechain_duck_bass(bass, rhythm)
            meters["sidechain_applied"] = True
            meters["sidechain_db"] = self._sidechain_db()

        harmonic = working.get("harmonic")
        # Pocket detector: every present vocal / lead bus with real signal.
        keys: list[str] = []
        detector: np.ndarray | None = None
        for bus in ("vocal", LEAD_BUS):
            audio = working.get(bus)
            if audio is None or not np.asarray(audio).size or rms_dbfs(audio) <= -60.0:
                continue
            keys.append(bus)
            mono = to_mono(audio)
            detector = mono if detector is None else detector + mono
        want_pocket = (not active) or bool(active & (VOCAL_STEM_NAMES | LEAD_STEM_NAMES))
        meters["pocket_requested_by"] = sorted(active & (VOCAL_STEM_NAMES | LEAD_STEM_NAMES))
        if want_pocket and harmonic is not None and np.asarray(harmonic).size and detector is not None:
            working["harmonic"] = self.vocal_pocket(harmonic, detector)
            meters["vocal_pocket_applied"] = True
            meters["vocal_pocket_db"] = self._pocket_db()
            meters["pocket_keyed_by"] = keys

        # Auto-makeup for steady-state EQ carve (clamped ~±1.9 dB).
        # Intentional sidechain valleys stay dynamic: gain cannot exceed 1.25.
        for bus, pre_rms in pre_rms_lin.items():
            audio = working.get(bus)
            if audio is None or np.asarray(audio).size == 0:
                continue
            stem_post = np.asarray(audio, dtype=np.float64)
            post_rms = float(np.sqrt(np.mean(stem_post * stem_post)) + 1e-9)
            makeup_gain = float(np.clip(pre_rms / post_rms, 0.8, 1.25))
            working[bus] = stem_post * makeup_gain
            meters[f"{bus}_makeup_gain"] = round(makeup_gain, 4)

        if apply_reverb:
            send = self._reverb_send()
            working = self.coherence_reverb(working, send=send)
            meters["reverb_send"] = send
            meters["reverb_n_stems"] = sum(
                1
                for bus in REVERB_BUSES
                if bus in working
                and np.asarray(working[bus]).size
                and rms_dbfs(working[bus]) > -70.0
            )

        mix = self._sum_stems(working, ref_len, ref_ch)
        meters["mix_peak_dbfs"] = peak_dbfs(mix)
        meters["mix_rms_dbfs"] = rms_dbfs(mix)
        for bus in MIX_BUSES:
            audio = working.get(bus)
            if audio is not None and np.asarray(audio).size:
                meters[f"{bus}_rms_dbfs"] = rms_dbfs(audio)

        return RelationalMixResult(stems=dict(working), mix=mix, meters=meters)

    def _sum_stems(
        self,
        stems: Mapping[str, np.ndarray],
        n: int,
        channels: int,
    ) -> np.ndarray:
        if n <= 0:
            return np.zeros(0, dtype=np.float64)
        acc = np.zeros((n, max(1, channels)), dtype=np.float64)
        any_stereo = channels > 1
        for bus in MIX_BUSES:
            audio = stems.get(bus)
            if audio is None or np.asarray(audio).size == 0:
                continue
            frames, was_1d = as_frames(align_length(audio, n))
            if frames.shape[1] == 1 and any_stereo:
                frames = np.repeat(frames, channels, axis=1)
            elif frames.shape[1] != acc.shape[1]:
                # Down/up mix simply: take first ch or tile.
                if frames.shape[1] > acc.shape[1]:
                    frames = frames[:, : acc.shape[1]]
                else:
                    frames = np.pad(frames, ((0, 0), (0, acc.shape[1] - frames.shape[1])))
            acc += frames
            _ = was_1d
        if channels == 1:
            return acc[:, 0]
        return acc

    def _sidechain_db(self) -> float:
        # Map mix_intents.sidechain_kick_bass (0..1) into 2..5 dB.
        t = _clip(float(self.mix_intents.sidechain_kick_bass), 0.0, 1.0)
        lo, hi = DEFAULT_SIDECHAIN_DB
        return lo + (hi - lo) * t

    def _pocket_db(self) -> float:
        # Prefer explicit vocal_pocket_db; clamp into 2..3 dB delivery range.
        raw = float(self.mix_intents.vocal_pocket_db)
        lo, hi = DEFAULT_POCKET_DB
        if raw < lo:
            # Intent may be 1..6 from Module 1; remap into window.
            t = _clip((raw - 1.0) / 5.0, 0.0, 1.0)
            return lo + (hi - lo) * t
        return _clip(raw, lo, hi)

    def _reverb_send(self) -> float:
        raw = float(self.mix_intents.shared_reverb_bus)
        lo, hi = DEFAULT_REVERB_SEND
        return _clip(raw, lo, hi)


def apply_relational_mix(
    stems: Mapping[str, np.ndarray],
    sr: int,
    *,
    mix_intents: MixIntents | Mapping[str, Any] | None = None,
    section: SectionPlan | Mapping[str, Any] | None = None,
) -> RelationalMixResult:
    """Convenience entry used by the assembler / conductor orchestration."""
    mixer = RelationalMixer(sr, mix_intents=mix_intents, section=section)
    return mixer.process(stems, section=section)


SectionWindow = tuple[Any, int, int]  # (section, start_sample, end_sample)


def apply_sectioned_relational_mix(
    stems: Mapping[str, np.ndarray],
    sr: int,
    windows: Sequence[SectionWindow],
    *,
    mix_intents: MixIntents | Mapping[str, Any] | None = None,
    xfade_ms: float = SECTION_XFADE_MS,
    warmup_ms: float = SECTION_WARMUP_MS,
) -> RelationalMixResult:
    """Relational mix applied per section window instead of one peak section.

    Each ``(section, start, end)`` window is processed with that section's
    ``active_stems`` / energy (sidechain, pocket, make-up) from
    ``start - warmup`` so filters and envelope followers have settled, then
    windows are blended over ``xfade_ms`` centred on each boundary. The blend
    is equal-gain (linear, gains sum to 1): both sides are the same source
    audio processed with different rules, so the signals are highly
    correlated and an equal-power (sin/cos) blend would swell up to +3 dB
    mid-fade. The shared-room reverb runs once over the stitched result so
    tails ring across section boundaries.

    Windows are clamped to the buffer; the first starts at 0 and the last
    ends at the buffer length.
    """
    mixer = RelationalMixer(sr, mix_intents=mix_intents)
    buses = [b for b in MIX_BUSES if b in stems and np.asarray(stems[b]).size]
    if not buses or not windows:
        return mixer.process(stems, section=windows[0][0] if windows else None)

    frames: dict[str, np.ndarray] = {}
    was_1d: dict[str, bool] = {}
    n = 0
    for bus in buses:
        f, one_d = as_frames(np.asarray(stems[bus], dtype=np.float64))
        frames[bus] = f
        was_1d[bus] = one_d
        n = max(n, f.shape[0])
    for bus in buses:
        frames[bus] = as_frames(align_length(frames[bus], n))[0]

    bounds: list[tuple[Any, int, int]] = []
    for i, (section, start, end) in enumerate(windows):
        s = 0 if i == 0 else int(np.clip(int(start), 0, n))
        e = n if i == len(windows) - 1 else int(np.clip(int(end), 0, n))
        if e > s:
            bounds.append((section, s, e))
    half = max(1, int(round(float(sr) * float(xfade_ms) / 2000.0)))
    warm = max(0, int(round(float(sr) * float(warmup_ms) / 1000.0)))

    out = {bus: np.zeros_like(frames[bus]) for bus in buses}
    section_meters: list[dict[str, Any]] = []
    for i, (section, s, e) in enumerate(bounds):
        first, last = i == 0, i == len(bounds) - 1
        lo = s if first else max(0, s - half)
        hi = e if last else min(n, e + half)
        wlo = max(0, lo - warm)
        window = {bus: frames[bus][wlo:hi] for bus in buses}
        result = mixer.mix(window, section=section, apply_reverb=False)
        gain = np.ones(hi - lo, dtype=np.float64)
        if not first:
            ramp = min(2 * half, hi - lo)
            gain[:ramp] = np.linspace(0.0, 1.0, ramp, endpoint=False) + 0.5 / ramp
        if not last:
            ramp = min(2 * half, hi - lo)
            gain[-ramp:] *= 1.0 - (np.linspace(0.0, 1.0, ramp, endpoint=False) + 0.5 / ramp)
        for bus in buses:
            processed = as_frames(np.asarray(result.stems[bus], dtype=np.float64))[0]
            out[bus][lo:hi] += processed[lo - wlo : hi - wlo] * gain[:, np.newaxis]
        name = section.get("name") if isinstance(section, Mapping) else getattr(section, "name", None)
        section_meters.append(
            {
                "section": name,
                "start_sample": s,
                "end_sample": e,
                "sidechain_applied": bool(result.meters.get("sidechain_applied")),
                "vocal_pocket_applied": bool(result.meters.get("vocal_pocket_applied")),
                "pocket_keyed_by": result.meters.get("pocket_keyed_by", []),
                "makeup_gains": {
                    k[: -len("_makeup_gain")]: v
                    for k, v in result.meters.items()
                    if k.endswith("_makeup_gain")
                },
            }
        )

    working: dict[str, np.ndarray] = {
        bus: restore_shape(out[bus], was_1d[bus]) for bus in buses
    }
    send = mixer._reverb_send()
    working = mixer.coherence_reverb(working, send=send)
    channels = max(f.shape[1] for f in frames.values())
    mix = mixer._sum_stems(working, n, channels)
    meters: dict[str, Any] = {
        "sectioned": True,
        "sections": section_meters,
        "sidechain_applied": any(m["sidechain_applied"] for m in section_meters),
        "vocal_pocket_applied": any(m["vocal_pocket_applied"] for m in section_meters),
        "reverb_send": send,
        "reverb_n_stems": sum(
            1 for bus in REVERB_BUSES if bus in working and rms_dbfs(working[bus]) > -70.0
        ),
        "section_xfade_ms": float(xfade_ms),
        "mix_peak_dbfs": peak_dbfs(mix),
        "mix_rms_dbfs": rms_dbfs(mix),
    }
    if meters["sidechain_applied"]:
        meters["sidechain_db"] = mixer._sidechain_db()
    if meters["vocal_pocket_applied"]:
        meters["vocal_pocket_db"] = mixer._pocket_db()
    return RelationalMixResult(stems=working, mix=mix, meters=meters)
