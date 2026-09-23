"""Unit tests for Module 3 song evaluator + regeneration gatekeeper."""
from __future__ import annotations

import json
import os
import sys
import tempfile

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.regeneration_gate import RegenerationGatekeeper  # noqa: E402
from engine.song_evaluator import (  # noqa: E402
    HARMONIC_PASS,
    SongEvaluator,
    chord_pitch_classes,
    measure_true_peak,
    progression_chroma_template,
)
from engine.song_plan import SectionPlan  # noqa: E402

SR = 44100


def _tone(n: int, hz: float, amp: float = 0.25) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / SR
    return amp * np.sin(2 * np.pi * hz * t)


def _chord_tone_stack(n: int, pitch_classes: set[int], amp: float = 0.2) -> np.ndarray:
    """Synthesize a consonant stack from pitch-class set (C4=60 base)."""
    out = np.zeros(n, dtype=np.float64)
    for pc in pitch_classes:
        midi = 60 + int(pc)
        hz = 440.0 * (2.0 ** ((midi - 69) / 12.0))
        out += _tone(n, hz, amp=amp / max(1, len(pitch_classes)))
    return out


def test_chord_pitch_classes_em():
    pcs = chord_pitch_classes("Em")
    assert pcs == {4, 7, 11}  # E G B


def test_harmonic_failure_flags_dissonant_signal():
    """Dissonant cluster vs Em-C-G-D progression should score low / fail."""
    n = SR  # 1s
    # Cluster of tritones / chromatic noise — not in Em/C/G/D templates.
    dissonant = (
        _tone(n, 233.08)  # Bb
        + _tone(n, 311.13)  # Eb
        + _tone(n, 370.0)  # F#
        + _tone(n, 466.16)  # Bb
    )
    section = SectionPlan(
        name="verse_1",
        start_bar=0,
        bars=4,
        energy_level=0.6,
        chord_progression=["Em", "C", "G", "D"],
        active_stems=["bass", "rhythm_guitar", "lead_vocal"],
        frequency_reservations={},
    )
    stems = {
        "harmonic": dissonant,
        "bass": _tone(n, 82.41, amp=0.15),  # E2 — still won't save the cluster
        "vocal": dissonant * 0.5,
        "rhythm": np.zeros(n),
    }
    mix = dissonant + stems["bass"]
    evaluator = SongEvaluator(lufs_tolerance=20.0)  # ignore loudness for this assert
    score = evaluator.evaluate(
        mix,
        SR,
        stems=stems,
        section=section,
        song_plan={"bpm": 120, "master_lufs_target": -14.0, "true_peak_limit": -1.0},
        scan_sections=False,
    )
    assert score.harmonic_coherence < 0.55
    assert score.passed is False
    assert any(s in score.failing_stems for s in ("harmonic", "vocal", "bass"))


def test_harmonic_pass_on_matching_progression():
    n = SR
    # Em triad tones dominate.
    harmonic = _chord_tone_stack(n, chord_pitch_classes("Em"), amp=0.35)
    section = SectionPlan(
        name="chorus_1",
        start_bar=0,
        bars=4,
        energy_level=0.8,
        chord_progression=["Em", "Em", "Em", "Em"],
        active_stems=["bass", "rhythm_guitar"],
        frequency_reservations={},
    )
    stems = {"harmonic": harmonic, "bass": _tone(n, 82.41, amp=0.2), "rhythm": np.zeros(n)}
    mix = harmonic + stems["bass"]
    # Scale to a safe peak.
    peak = float(np.max(np.abs(mix))) + 1e-12
    mix = mix * (0.5 / peak)
    stems = {k: v * (0.5 / peak) for k, v in stems.items()}
    score = SongEvaluator(lufs_tolerance=30.0).evaluate(
        mix,
        SR,
        stems=stems,
        section=section,
        song_plan={"bpm": 120, "true_peak_limit": -1.0},
        scan_sections=False,
    )
    assert score.harmonic_coherence >= HARMONIC_PASS


def test_peak_meter_flags_clipping_above_minus_one_dbtp():
    n = SR // 4
    # Near-full-scale square-ish burst → true peak above -1.0 dBTP.
    hot = np.ones(n, dtype=np.float64) * 0.98
    hot[::2] *= -1.0
    dbtp = measure_true_peak(hot, SR)
    assert dbtp > -1.0

    score = SongEvaluator(lufs_tolerance=40.0, true_peak_limit=-1.0).evaluate(
        hot,
        SR,
        stems={"harmonic": hot},
        section=SectionPlan(
            name="drop",
            start_bar=0,
            bars=2,
            energy_level=1.0,
            chord_progression=["Em"],
            active_stems=["synth"],
            frequency_reservations={},
        ),
        song_plan={"bpm": 120, "true_peak_limit": -1.0, "master_lufs_target": -14.0},
        scan_sections=False,
    )
    assert score.true_peak_dbtp > -1.0
    assert score.passed is False
    assert "harmonic" in score.failing_stems


def test_selective_section_regeneration_preserves_good_bars():
    """Failing section is retried; validated section audio is left untouched."""
    bpm = 120.0
    spb = int(round(SR * 60.0 * 4.0 / bpm))  # samples per bar (4/4)
    # Keep sections short for speed: 1 bar each.
    good_n = 1 * spb
    bad_n = 1 * spb
    total = good_n + bad_n

    good_audio = _chord_tone_stack(good_n, chord_pitch_classes("Em"), amp=0.3)
    # Strong dissonant second section (chromatic cluster).
    bad_audio = sum(_tone(bad_n, hz, 0.28) for hz in (233.08, 246.94, 277.18, 311.13, 370.0))
    harmonic = np.concatenate([good_audio, bad_audio])
    peak = float(np.max(np.abs(harmonic))) + 1e-12
    harmonic = harmonic * (0.45 / peak)
    good_snapshot = harmonic[:good_n].copy()

    stems = {
        "harmonic": harmonic.copy(),
        "bass": np.zeros(total),
        "rhythm": np.zeros(total),
        "vocal": np.zeros(total),
    }
    mix = harmonic.copy()

    song_plan = {
        "bpm": bpm,
        "master_lufs_target": -14.0,
        "true_peak_limit": -1.0,
        "sections": [
            {
                "name": "verse_1",
                "start_bar": 0,
                "bars": 1,
                "energy_level": 0.5,
                "chord_progression": ["Em"],
                "active_stems": ["rhythm_guitar"],
                "frequency_reservations": {},
            },
            {
                "name": "chorus_1",
                "start_bar": 1,
                "bars": 1,
                "energy_level": 0.9,
                "chord_progression": ["Em"],
                "active_stems": ["rhythm_guitar"],
                "frequency_reservations": {},
            },
        ],
    }

    calls: list[tuple[str, str, int, int]] = []

    def regenerate(stem_name, section, start, end, attempt):
        length = end - start
        calls.append((stem_name, section.name, attempt, length))
        fixed = _chord_tone_stack(length, chord_pitch_classes("Em"), amp=0.3)
        peak_f = float(np.max(np.abs(fixed))) + 1e-12
        return fixed * (0.45 / peak_f)

    with tempfile.TemporaryDirectory() as tmp:
        gate = RegenerationGatekeeper(
            evaluator=SongEvaluator(lufs_tolerance=40.0, composite_pass=0.80),
            max_retries=2,
        )
        result = gate.run(
            stems,
            mix,
            SR,
            song_plan=song_plan,
            regenerate_fn=regenerate,
            report_dir=tmp,
        )
        report_path = os.path.join(tmp, "quality_report.json")
        assert os.path.isfile(report_path)

    # Good verse region must be byte-identical (never re-rendered).
    assert np.allclose(result.stems["harmonic"][:good_n], good_snapshot, atol=1e-9)
    # Regeneration must be localized to chorus bars only (not full song).
    assert calls, "expected at least one localized regeneration call"
    assert all(c[1] == "chorus_1" for c in calls)
    assert all(c[2] <= 2 for c in calls)
    assert all(c[3] == bad_n for c in calls)
    assert all(c[3] < total for c in calls)
    assert "verse_1" in result.preserved_sections or "verse_1" not in {
        c[1] for c in calls
    }


def test_gate_writes_quality_report_without_regenerator():
    n = SR // 2
    mix = _tone(n, 440.0, amp=0.2)
    stems = {"harmonic": mix, "bass": np.zeros(n), "rhythm": np.zeros(n), "vocal": np.zeros(n)}
    with tempfile.TemporaryDirectory() as tmp:
        from engine.local_song_conductor import gate_conducted_mix

        result = gate_conducted_mix(
            stems,
            mix,
            {
                "song_plan": {
                    "bpm": 120,
                    "master_lufs_target": -14.0,
                    "true_peak_limit": -1.0,
                    "sections": [],
                }
            },
            sr=SR,
            report_dir=tmp,
        )
        assert result.report_path and os.path.isfile(result.report_path)
        data = json.loads(open(result.report_path, encoding="utf-8").read())
        assert "integrated_lufs" in data
        assert "true_peak_dbtp" in data


def _section(chords=("Em", "C", "G", "D")) -> SectionPlan:
    return SectionPlan(
        name="verse_1",
        start_bar=0,
        bars=4,
        energy_level=0.5,
        chord_progression=list(chords),
        active_stems=["rhythm_guitar"],
        frequency_reservations={},
    )


def test_flat_chroma_noise_scores_zero_after_floor_removal():
    noise = 0.1 * np.random.default_rng(1).standard_normal(SR)
    score = SongEvaluator(check_loudness=False).evaluate(
        noise, SR, stems={"harmonic": noise}, section=_section(), scan_sections=False
    )
    assert score.harmonic_coherence < 0.05
    assert "harmonic" in score.failing_stems


def test_distorted_in_key_chord_is_not_flagged():
    em = _chord_tone_stack(SR, chord_pitch_classes("Em"), amp=0.35)
    saturated = np.tanh(8.0 * em)
    score = SongEvaluator(check_loudness=False).evaluate(
        saturated, SR, stems={"harmonic": saturated}, section=_section(), scan_sections=False
    )
    assert score.harmonic_coherence >= 0.25
    assert "harmonic" not in score.failing_stems


def test_pre_master_gate_ignores_loudness_and_stem_peaks():
    # In key, far below -14 LUFS, and a stem over the -1 dBTP ceiling.
    em = _chord_tone_stack(SR, chord_pitch_classes("Em"), amp=0.35)
    quiet_mix = em * 0.02
    hot_stem = em * (1.2 / (float(np.max(np.abs(em))) + 1e-12))
    section = _section(("Em",))
    strict = SongEvaluator().evaluate(
        quiet_mix, SR, stems={"harmonic": hot_stem}, section=section, scan_sections=False
    )
    assert strict.passed is False and strict.details["loudness_ok"] is False
    assert "harmonic" in strict.failing_stems
    pre_master = SongEvaluator(check_loudness=False).evaluate(
        quiet_mix, SR, stems={"harmonic": hot_stem}, section=section, scan_sections=False
    )
    assert pre_master.details["loudness_ok"] is True
    assert pre_master.details["loudness_checked"] is False
    assert pre_master.failing_stems == []
    assert pre_master.integrated_lufs < -20.0  # still measured and reported


def test_gate_does_not_regenerate_when_no_section_fails():
    n = SR
    em = _chord_tone_stack(n, chord_pitch_classes("Em"), amp=0.3)
    calls: list[str] = []

    def regenerate(stem_name, section, start, end, attempt):
        calls.append(section.name)
        return np.zeros(end - start)

    plan = {
        "bpm": 120,
        "sections": [
            {
                "name": "verse_1",
                "start_bar": 0,
                "bars": 2,
                "energy_level": 0.5,
                "chord_progression": ["Em"],
                "active_stems": ["rhythm_guitar"],
                "frequency_reservations": {},
            }
        ],
    }
    # Unreachable composite forces a global "not passed" with no failing section.
    gate = RegenerationGatekeeper(
        evaluator=SongEvaluator(check_loudness=False, composite_pass=1.0),
        min_composite=0.0,
    )
    gate.evaluator._flag_failing_sections = lambda *a, **k: []  # type: ignore[method-assign]
    result = gate.run({"harmonic": em}, em, SR, song_plan=plan, regenerate_fn=regenerate)
    assert result.score.passed is False
    assert calls == []
    assert np.array_equal(result.stems["harmonic"], em)


def test_splice_seams_are_crossfaded_without_clicks():
    from engine.regeneration_gate import _replace_region

    n = SR
    t = np.arange(n) / SR
    dest = 0.5 * np.sin(2 * np.pi * 220.0 * t)
    replacement = -0.5 * np.ones(20000)  # worst case: DC step against a sine
    start, end = 10000, 30000
    out = _replace_region(dest, replacement, start, end)
    assert np.array_equal(out[:start], dest[:start])
    assert np.array_equal(out[end:], dest[end:])
    fade = min(256, (end - start) // 4)
    assert np.allclose(out[start + fade : end - fade], -0.5)
    # |d(a*cos + b*sin)| <= |da| + (|a|+|b|)*dtheta with |a|,|b| <= 0.5; a hard
    # splice here would jump by up to 1.0 in one sample.
    body_step = float(np.max(np.abs(np.diff(dest))))
    bound = body_step + 1.1 * (0.5 * np.pi) / (fade - 1)
    for seam in (out[start - 2 : start + fade + 2], out[end - fade - 2 : end + 2]):
        assert float(np.max(np.abs(np.diff(seam)))) < bound


def test_invalid_mix_intents_are_logged(capsys):
    from engine.relational_mixer import RelationalMixer

    mixer = RelationalMixer(SR, mix_intents={"sidechain_kick_bass": 7.0})
    assert "[RELATIONAL] invalid mix_intents, using defaults" in capsys.readouterr().out
    assert mixer.mix_intents.sidechain_kick_bass == 0.35


def test_progression_template_nonzero():
    tmpl = progression_chroma_template(["Em", "C", "G", "D"])
    assert tmpl.shape == (12,)
    assert float(np.sum(tmpl)) > 0.0
