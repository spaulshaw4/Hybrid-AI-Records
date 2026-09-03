"""The assembler must render a section map: buses drop out and come back."""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.arrangement_brain import (  # noqa: E402
    apply_arrangement_to_blueprint,
    build_arrangement,
)
from engine.blueprint_track_assembler import (  # noqa: E402
    ARRANGE_BUSES,
    DEFAULT_BUS_TARGET_RMS,
    DynamicSliceRotator,
    _activation_envelope,
    _section_segments,
    assemble_arranged_buses,
    assemble_from_blueprint,
    samples_for_bars,
    samples_per_bar,
    section_bus_activation,
)

SR = 22050
BPM = 140.0


def _tone(freq: float, seconds: float, sr: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sr), dtype=np.float64) / sr
    wave = 0.30 * np.sin(2.0 * np.pi * freq * t)
    return np.column_stack([wave, wave])


@pytest.fixture()
def corpus(tmp_path):
    root = tmp_path / "session_slices"
    root.mkdir()
    plan = {
        "rhythm": (220.0, 4),
        "bass": (60.0, 3),
        "harmonic": (440.0, 4),
        "vocal": (880.0, 4),
    }
    for stem, (freq, count) in plan.items():
        for i in range(count):
            sf.write(
                str(root / f"{stem}_{stem}_s4_{i:03d}.wav"),
                _tone(freq * (1.0 + 0.05 * i), 2.0),
                SR,
                subtype="PCM_24",
            )
    return root


def _section(name, bars, activation, variant=None, fills=None):
    return {
        "name": name,
        "bars": bars,
        "slice_count": bars,
        "energy": 0.5,
        "volume_weights": {"rhythm": 0.5, "harmonic": 0.5, "lead": 0.5, "vocal": 0.5},
        "bus_activation": dict(activation),
        "bus_variant": dict(variant or {b: 0 for b in ARRANGE_BUSES}),
        "fill_bars": list(fills or []),
        "query_tags": {},
        "dsp_filters": {},
    }


# --------------------------------------------------------------------------
# section bar math
# --------------------------------------------------------------------------


def test_samples_per_bar_is_the_documented_formula():
    assert samples_per_bar(44100, 140.0) == int(44100 * 240.0 / 140.0)
    assert samples_for_bars(8, 140.0, 44100) == 8 * samples_per_bar(44100, 140.0)


def test_section_bus_activation_returns_none_for_legacy_sections():
    assert section_bus_activation({"name": "verse"}) is None
    assert section_bus_activation({"bus_activation": {"rhythm": 1.0}}) is not None


# --------------------------------------------------------------------------
# activation envelope
# --------------------------------------------------------------------------


def _plan(sections):
    return [(s, s["bars"], samples_for_bars(s["bars"], BPM, SR)) for s in sections]


def test_envelope_mutes_a_bus_for_a_whole_section():
    sections = [
        _section("intro", 2, {"rhythm": 0.8, "bass": 0.0, "harmonic": 0.7, "vocal": 0.0}),
        _section("verse", 2, {"rhythm": 0.8, "bass": 0.9, "harmonic": 0.6, "vocal": 0.7}),
    ]
    plan = _plan(sections)
    total = sum(n for _s, _b, n in plan)
    env = _activation_envelope(plan, "bass", total, SR)
    first = plan[0][2]
    assert float(np.max(env[: first - 1])) == 0.0
    assert float(np.max(env[first:])) == pytest.approx(0.9)


def test_envelope_ramps_instead_of_stepping():
    sections = [
        _section("a", 2, {"rhythm": 0.0, "bass": 0.0, "harmonic": 0.0, "vocal": 0.0}),
        _section("b", 2, {"rhythm": 1.0, "bass": 0.0, "harmonic": 0.0, "vocal": 0.0}),
    ]
    plan = _plan(sections)
    total = sum(n for _s, _b, n in plan)
    env = _activation_envelope(plan, "rhythm", total, SR)
    boundary = plan[0][2]
    ramp = env[boundary : boundary + int(SR * 0.02), 0]
    assert ramp[0] < 0.05
    assert ramp[-1] > 0.9
    assert float(np.max(np.abs(np.diff(ramp)))) < 0.05


def test_envelope_fades_out_at_the_end_of_the_track():
    sections = [_section("a", 2, {b: 1.0 for b in ARRANGE_BUSES})]
    plan = _plan(sections)
    total = plan[0][2]
    env = _activation_envelope(plan, "rhythm", total, SR)
    assert env[-1, 0] < 0.05


# --------------------------------------------------------------------------
# fill segmentation
# --------------------------------------------------------------------------


def test_a_section_without_fills_is_one_steady_loop():
    section = _section("verse", 8, {b: 1.0 for b in ARRANGE_BUSES})
    bar = samples_per_bar(SR, BPM)
    segments = _section_segments(section, 8, bar, 8 * bar, 0, 2, allow_fills=True)
    assert segments == [(0, 8 * bar, 0)]


def test_a_fill_swaps_one_bar_to_another_variant():
    section = _section("verse", 8, {b: 1.0 for b in ARRANGE_BUSES}, fills=[7])
    bar = samples_per_bar(SR, BPM)
    segments = _section_segments(section, 8, bar, 8 * bar, 0, 2, allow_fills=True)
    assert len(segments) == 2
    assert segments[0][2] == 0
    assert segments[1][2] == 1
    assert segments[1][1] == bar
    assert sum(length for _o, length, _v in segments) == 8 * bar


def test_fills_are_ignored_when_only_one_variant_exists():
    section = _section("verse", 8, {b: 1.0 for b in ARRANGE_BUSES}, fills=[7])
    bar = samples_per_bar(SR, BPM)
    assert _section_segments(section, 8, bar, 8 * bar, 0, 1, allow_fills=True) == [
        (0, 8 * bar, 0)
    ]


# --------------------------------------------------------------------------
# full bus render
# --------------------------------------------------------------------------


def _rotators(corpus_dir):
    import glob

    pools = {
        bus: sorted(glob.glob(os.path.join(str(corpus_dir), f"{bus}_*.wav")))
        for bus in ARRANGE_BUSES
    }
    return {bus: DynamicSliceRotator(paths, seed=7) for bus, paths in pools.items()}


def test_rendered_bus_is_silent_where_the_section_map_mutes_it(corpus):
    sections = [
        _section("intro", 2, {"rhythm": 0.8, "bass": 0.0, "harmonic": 0.7, "vocal": 0.0}),
        _section("chorus", 2, {"rhythm": 0.9, "bass": 0.9, "harmonic": 0.8, "vocal": 0.9}),
    ]
    plan = _plan(sections)
    total = sum(n for _s, _b, n in plan)
    staged = assemble_arranged_buses(
        plan, _rotators(corpus), total, SR, BPM, 2, None, None, 441
    )
    staged.pop("_envelopes")
    intro_n = plan[0][2]
    for bus in ("bass", "vocal"):
        intro_peak = float(np.max(np.abs(staged[bus][: intro_n - 441])))
        chorus_peak = float(np.max(np.abs(staged[bus][intro_n + 441 :])))
        assert intro_peak < 1e-6, f"{bus} leaked into a muted intro"
        assert chorus_peak > 1e-3, f"{bus} never came back in"


def test_every_bus_reaches_its_rms_target(corpus):
    sections = [_section("chorus", 4, {b: 1.0 for b in ARRANGE_BUSES})]
    plan = _plan(sections)
    total = plan[0][2]
    staged = assemble_arranged_buses(
        plan, _rotators(corpus), total, SR, BPM, 2, None, None, 441
    )
    envelopes = staged.pop("_envelopes")
    for bus in ARRANGE_BUSES:
        active = envelopes[bus][:, 0] > 0.02
        rms = 20.0 * np.log10(max(1e-12, float(np.sqrt(np.mean(staged[bus][active] ** 2)))))
        assert rms == pytest.approx(DEFAULT_BUS_TARGET_RMS[bus], abs=1.5)


def test_vocal_bus_is_not_buried_under_the_drums(corpus):
    """The defect being fixed: vocal sat 18 dB under rhythm in the old render."""
    sections = [_section("chorus", 4, {b: 1.0 for b in ARRANGE_BUSES})]
    plan = _plan(sections)
    staged = assemble_arranged_buses(
        plan, _rotators(corpus), plan[0][2], SR, BPM, 2, None, None, 441
    )
    envelopes = staged.pop("_envelopes")

    def rms(bus):
        active = envelopes[bus][:, 0] > 0.02
        return 20.0 * np.log10(max(1e-12, float(np.sqrt(np.mean(staged[bus][active] ** 2)))))

    assert rms("rhythm") - rms("vocal") < 6.0
    assert rms("rhythm") - rms("bass") < 6.0


def test_genre_targets_override_the_defaults(corpus):
    sections = [_section("chorus", 4, {b: 1.0 for b in ARRANGE_BUSES})]
    plan = _plan(sections)
    staged = assemble_arranged_buses(
        plan, _rotators(corpus), plan[0][2], SR, BPM, 2, None, None, 441,
        bus_targets={"vocal": -11.0},
    )
    envelopes = staged.pop("_envelopes")
    active = envelopes["vocal"][:, 0] > 0.02
    rms = 20.0 * np.log10(max(1e-12, float(np.sqrt(np.mean(staged["vocal"][active] ** 2)))))
    assert rms == pytest.approx(-11.0, abs=1.5)


# --------------------------------------------------------------------------
# end to end through assemble_from_blueprint
# --------------------------------------------------------------------------


def _write_arranged_blueprint(tmp_path, seed):
    blueprint = {
        "track_metadata": {
            "title": "t", "bpm": BPM, "root_key": "D",
            "genre": "nu_metal", "total_bars": 16,
        },
        "sections": [
            {
                "name": "intro", "slice_count": 4, "energy": 0.3,
                "volume_weights": {"rhythm": 0.4, "harmonic": 0.7, "lead": 0.2, "vocal": 0.0},
                "query_tags": {}, "dsp_filters": {},
            }
        ],
    }
    plan = build_arrangement("heavy riff track", "nu_metal", BPM, 12.0, seed=seed)
    apply_arrangement_to_blueprint(blueprint, plan)
    path = tmp_path / f"blueprint_{seed}.json"
    path.write_text(json.dumps(blueprint), encoding="utf-8")
    return str(path), plan


def test_assemble_renders_an_arranged_blueprint(tmp_path, corpus):
    blueprint_path, plan = _write_arranged_blueprint(tmp_path, 4242)
    out = str(tmp_path / "mix.wav")
    trace: dict = {}
    assemble_from_blueprint(
        blueprint_path, str(corpus), out, sr=SR, seed=4242,
        use_index=False, source_trace=trace,
    )
    audio, sr = sf.read(out, always_2d=True)
    assert sr == SR
    expected = sum(samples_for_bars(s["bars"], BPM, SR) for s in plan["sections"])
    assert audio.shape[0] == expected
    assert float(np.max(np.abs(audio))) <= 10.0 ** (-3.0 / 20.0) + 1e-6
    assert trace["_track"]["arranged"] is True
    assert set(trace["_buses"]) == set(ARRANGE_BUSES)


def test_arranged_render_keeps_section_order_from_the_brain(tmp_path, corpus):
    blueprint_path, plan = _write_arranged_blueprint(tmp_path, 77)
    trace: dict = {}
    assemble_from_blueprint(
        blueprint_path, str(corpus), str(tmp_path / "m.wav"), sr=SR,
        seed=77, use_index=False, source_trace=trace,
    )
    traced = [k for k in trace if not k.startswith("_")]
    assert traced == [s["name"] for s in plan["sections"]]


def test_two_seeds_produce_measurably_different_audio(tmp_path, corpus):
    outs = []
    for seed in (101, 202):
        blueprint_path, _ = _write_arranged_blueprint(tmp_path, seed)
        out = str(tmp_path / f"mix_{seed}.wav")
        assemble_from_blueprint(
            blueprint_path, str(corpus), out, sr=SR, seed=seed, use_index=False
        )
        outs.append(sf.read(out, always_2d=True)[0])
    n = min(len(outs[0]), len(outs[1]))
    assert not np.allclose(outs[0][:n], outs[1][:n], atol=1e-4)
