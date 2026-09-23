"""Unit tests for Module 2 relational mixer."""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.dsp_utils import (  # noqa: E402
    envelope_follower,
    lowpass,
    peak_dbfs,
    rms_dbfs,
)
from engine.relational_mixer import (  # noqa: E402
    RelationalMixer,
    apply_relational_mix,
)
from engine.song_plan import MixIntents, SectionPlan  # noqa: E402

SR = 44100


def _kick_pulse(n: int, hits: list[int], width: int = 64) -> np.ndarray:
    """Synthetic kick-ish clicks (low-frequency bursts)."""
    x = np.zeros(n, dtype=np.float64)
    t = np.arange(width, dtype=np.float64)
    burst = np.sin(2 * np.pi * 60.0 * t / SR) * np.exp(-t / 18.0)
    for hit in hits:
        end = min(n, hit + width)
        x[hit:end] += burst[: end - hit]
    return x


def _bass_tone(n: int, hz: float = 55.0) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / SR
    return 0.4 * np.sin(2 * np.pi * hz * t)


def _vocal_mid(n: int, hz: float = 2000.0) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / SR
    return 0.35 * np.sin(2 * np.pi * hz * t)


def _harmonic_mid(n: int) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / SR
    return 0.25 * np.sin(2 * np.pi * 1800.0 * t) + 0.15 * np.sin(2 * np.pi * 900.0 * t)


def test_sidechain_attenuates_bass_low_end_on_kick():
    n = SR  # 1 second
    rhythm = _kick_pulse(n, [0, SR // 2])
    bass = _bass_tone(n)
    mixer = RelationalMixer(
        SR,
        mix_intents=MixIntents(sidechain_kick_bass=1.0, shared_reverb_bus=0.10),
    )
    ducked = mixer.sidechain_duck_bass(bass, rhythm, duck_db=5.0)

    # Compare low-band energy around the first kick vs unducked bass.
    window = slice(0, 4000)
    bass_lp = lowpass(bass[window], SR, 120.0)
    duck_lp = lowpass(ducked[window], SR, 120.0)
    assert rms_dbfs(duck_lp) < rms_dbfs(bass_lp) - 0.5


def test_vocal_pocket_dips_conflicting_mids():
    n = SR
    harmonic = _harmonic_mid(n)
    vocal = _vocal_mid(n)
    mixer = RelationalMixer(SR, mix_intents=MixIntents(vocal_pocket_db=3.0, shared_reverb_bus=0.10))
    pocketed = mixer.vocal_pocket(harmonic, vocal, cut_db=3.0)

    # Mid-band RMS of harmonic should drop when vocal is present.
    from engine.dsp_utils import bandpass

    h_mid = bandpass(harmonic, SR, 1000.0, 3500.0)
    p_mid = bandpass(pocketed, SR, 1000.0, 3500.0)
    assert rms_dbfs(p_mid) < rms_dbfs(h_mid) - 0.3


def test_missing_vocal_is_non_destructive():
    n = SR // 2
    harmonic = _harmonic_mid(n)
    mixer = RelationalMixer(SR)
    out = mixer.vocal_pocket(harmonic, None)
    assert np.allclose(out, harmonic)
    out2 = mixer.vocal_pocket(harmonic, np.zeros(n))
    # Silent vocal -> envelope below gate -> passthrough.
    assert np.allclose(out2, harmonic, atol=1e-9)


def test_missing_rhythm_skips_sidechain_safely():
    n = SR // 4
    bass = _bass_tone(n)
    mixer = RelationalMixer(SR)
    out = mixer.sidechain_duck_bass(bass, np.zeros(n))
    assert np.allclose(out, bass, atol=1e-9)


def test_process_returns_stems_and_mix():
    n = SR // 2
    stems = {
        "rhythm": _kick_pulse(n, [0, n // 2]),
        "bass": _bass_tone(n),
        "harmonic": _harmonic_mid(n),
        "vocal": _vocal_mid(n),
    }
    section = SectionPlan(
        name="chorus_1",
        start_bar=0,
        bars=8,
        energy_level=0.9,
        chord_progression=["Em", "C", "G", "D"],
        active_stems=["drums", "bass", "rhythm_guitar", "lead_vocal"],
        frequency_reservations={"lead_vocal": "1kHz-3kHz", "kick": "40Hz-90Hz"},
    )
    result = apply_relational_mix(
        stems,
        SR,
        mix_intents=MixIntents(
            sidechain_kick_bass=0.8,
            vocal_pocket_db=2.5,
            shared_reverb_bus=0.15,
        ),
        section=section,
    )
    assert set(result.stems) >= {"rhythm", "bass", "harmonic", "vocal"}
    assert result.mix.size > 0
    assert result.meters["sidechain_applied"] is True
    assert result.meters["vocal_pocket_applied"] is True
    assert 0.10 <= result.meters["reverb_send"] <= 0.25
    assert peak_dbfs(result.mix) > -80.0


def test_optional_synth_absence_does_not_raise():
    n = SR // 4
    stems = {
        "rhythm": _kick_pulse(n, [0]),
        "bass": _bass_tone(n),
        "harmonic": _harmonic_mid(n),
        # no vocal / synth
    }
    result = apply_relational_mix(stems, SR, mix_intents=MixIntents(shared_reverb_bus=0.12))
    assert result.meters["vocal_pocket_applied"] is False
    assert "bass" in result.stems
    assert result.mix.shape[0] == n


def test_reverb_is_per_bus_without_bleed_and_keeps_tails():
    n = SR * 2
    t = np.arange(n) / SR
    vocal = np.zeros(n)
    vocal[: SR // 2] = 0.3 * np.sin(2 * np.pi * 440.0 * t[: SR // 2])
    drums = np.zeros(n)
    drums[SR + SR // 2 : SR + SR // 2 + 200] = 0.8
    mixer = RelationalMixer(SR)
    dry = {"rhythm": drums.copy(), "vocal": vocal.copy()}
    wet = mixer.coherence_reverb(dry, send=0.25)
    # Drums stem is untouched before its own hit: no vocal reverb in it.
    assert float(np.max(np.abs(wet["rhythm"][: SR + SR // 2]))) < 1e-9
    # Vocal tail rings past the dry signal instead of being gated to zero.
    tail = wet["vocal"][SR // 2 + 50 : SR // 2 + SR // 4]
    assert float(np.sqrt(np.mean(tail * tail))) > 1e-4


def test_reverb_total_wet_power_is_stable_across_bus_count():
    n = SR
    rng = np.random.default_rng(4)
    buses = {name: 0.1 * rng.standard_normal(n) for name in ("rhythm", "harmonic", "vocal")}
    mixer = RelationalMixer(SR)

    def total_wet(names):
        dry = {k: buses[k].copy() for k in names}
        wet = mixer.coherence_reverb(dry, send=0.25)
        added = sum(wet[k] - dry[k] for k in names)
        return float(np.sqrt(np.mean(added * added)))

    one = total_wet(["harmonic"])
    three = total_wet(["rhythm", "harmonic", "vocal"])
    assert 0.75 * one <= three <= 1.25 * one


def test_envelope_follower_tracks_transient():
    n = SR // 10
    x = np.zeros(n)
    x[10:40] = 1.0
    env = envelope_follower(x, SR, attack_ms=5.0, release_ms=80.0)
    assert float(np.max(env)) > 0.5
    assert env[0] < env[20]


def test_conductor_mix_helper_uses_song_plan_intents():
    from engine.local_song_conductor import mix_conducted_stems

    n = SR // 4
    stems = {
        "rhythm": _kick_pulse(n, [0]),
        "bass": _bass_tone(n),
        "harmonic": _harmonic_mid(n),
        "vocal": np.zeros(n),
    }
    arrangement = {
        "song_plan": {
            "mix_intents": {
                "sidechain_kick_bass": 0.9,
                "vocal_pocket_db": 2.0,
                "shared_reverb_bus": 0.12,
                "frequency_mask_mid_db": 3.0,
            },
            "sections": [
                {
                    "name": "drop",
                    "energy_level": 1.0,
                    "active_stems": ["drums", "bass"],
                }
            ],
        }
    }
    result = mix_conducted_stems(stems, arrangement, sr=SR)
    assert result.meters["sidechain_applied"] is True
    # Silent vocal -> pocket not applied (non-destructive fallback).
    assert result.meters["vocal_pocket_applied"] is False
