"""Tests for the mix-bus crest factor control stage."""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from dsp.crest_control import (  # noqa: E402
    DEFAULT_TARGET_PLR_DB,
    MAX_LEVEL_DB,
    PLR_TOLERANCE_DB,
    _macro_gain,
    control_crest,
)
from engine.conductor_matrix import MONO_CORRELATION_FLOOR, stereo_correlation  # noqa: E402
from engine.song_evaluator import measure_integrated_lufs, measure_true_peak  # noqa: E402

SR = 44100


def _plr(audio: np.ndarray) -> float:
    return float(measure_true_peak(audio, SR) - measure_integrated_lufs(audio, SR))


def _stereo(n: int, seed: int, width: float = 0.45) -> np.ndarray:
    """Tone plus noise with a fixed amount of side, so L/R stay coherent."""
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    mid = np.sin(2.0 * np.pi * 110.0 * t) + 0.7 * rng.normal(0.0, 1.0, n)
    side = width * rng.normal(0.0, 1.0, n)
    return np.column_stack((mid + side, mid - side))


def _body(n: int, seed: int, level: float = 0.05) -> np.ndarray:
    """Steady musical bed at a sane mix level."""
    bed = _stereo(n, seed)
    return bed * (level / float(np.max(np.abs(bed))))


def _spiky_mix(n: int = SR * 20, seed: int = 3) -> np.ndarray:
    """Quiet bed with one hot fill bar, which is what the arranger hands over.

    Proportions follow the real defect: a bar and a half of drum fill sitting
    ~25 dB over the body of an otherwise sparse track, normalised to the
    assembler's -3 dBFS headroom target.
    """
    mix = _body(n, seed, level=1.0)
    fill = slice(n // 2, n // 2 + int(1.5 * SR))
    hits = np.zeros(fill.stop - fill.start)
    hits[:: SR // 8] = 1.0
    env = np.convolve(hits, np.exp(-np.arange(1500) / 220.0))[: hits.size]
    burst = _stereo(hits.size, seed + 100) * env[:, np.newaxis]
    # 15 dB over the body of the track, which is the gap the real renders show.
    mix[fill] += burst * (10.0 ** (15.0 / 20.0) / float(np.max(np.abs(burst))))
    return mix * (10.0 ** (-3.0 / 20.0) / float(np.max(np.abs(mix))))


def test_high_crest_mix_is_brought_into_the_target_band():
    mix = _spiky_mix()
    before = _plr(mix)
    assert before > 20.0, f"fixture is not spiky enough: {before:.2f} dB"

    out, gain, report = control_crest(mix, SR)
    assert report.engaged
    after = _plr(out)
    assert after < before - 5.0
    # The stage aims at DEFAULT_TARGET_PLR_DB and measures out a little above
    # it, because the soft clipper asymptotes rather than reaching its ceiling.
    assert DEFAULT_TARGET_PLR_DB - 1.0 <= after <= DEFAULT_TARGET_PLR_DB + 3.0
    assert out.shape == mix.shape
    assert gain.shape == (mix.shape[0], 1)


def test_material_already_in_band_is_an_exact_no_op():
    mix = _body(SR * 8, 11)
    assert _plr(mix) <= DEFAULT_TARGET_PLR_DB + PLR_TOLERANCE_DB
    out, gain, report = control_crest(mix, SR)
    assert not report.engaged
    assert np.array_equal(out, mix)
    assert np.all(gain == 1.0)


def test_is_deterministic():
    mix = _spiky_mix()
    first, gain_a, report_a = control_crest(mix, SR)
    second, gain_b, report_b = control_crest(mix, SR)
    assert np.array_equal(first, second)
    assert np.array_equal(gain_a, gain_b)
    assert report_a == report_b


def test_does_not_raise_the_sample_peak():
    mix = _spiky_mix()
    out, _gain, _report = control_crest(mix, SR)
    # Makeup restores the input sample peak exactly, so the stage never eats
    # into the headroom the assembler staged for the master chain.
    assert float(np.max(np.abs(out))) <= float(np.max(np.abs(mix))) + 1e-9
    # Lifting the body of the track lifts its inter-sample peaks with it, so
    # true peak does creep up; what has to hold is that the staged mix carries
    # no inter-sample over. The -1 dBTP delivery ceiling is the limiter's job
    # and is covered by the mastering test below.
    assert measure_true_peak(out, SR) < 0.0


def test_mastering_still_holds_the_ceiling_and_reaches_the_lufs_window():
    from engine.mastering_bus import MasteringBus

    out, _gain, _report = control_crest(_spiky_mix(SR * 20, seed=5), SR)
    _master, report = MasteringBus().process(out, SR)
    assert report.true_peak_dbtp <= -1.0 + 1e-6
    assert abs(report.integrated_lufs + 14.0) <= 0.5


def test_stereo_correlation_is_preserved():
    mix = _spiky_mix()
    before = stereo_correlation(mix)
    out, _gain, _report = control_crest(mix, SR)
    after = stereo_correlation(out)
    # One broadband gain applied to both channels leaves the L/R ratio alone
    # sample by sample; correlation only shifts as far as the ride reweights
    # which passages dominate the measurement.
    assert abs(after - before) < 0.05
    assert after >= MONO_CORRELATION_FLOOR


def test_narrow_stereo_mix_stays_above_the_mono_floor():
    n = SR * 10
    mix = _spiky_mix(n, seed=7)
    mid = 0.5 * (mix[:, 0] + mix[:, 1])
    side = 0.5 * (mix[:, 0] - mix[:, 1]) * 0.5
    narrow = np.column_stack((mid + side, mid - side))
    assert stereo_correlation(narrow) >= MONO_CORRELATION_FLOOR
    out, _gain, _report = control_crest(narrow, SR)
    assert stereo_correlation(out) >= MONO_CORRELATION_FLOOR


def test_silence_is_returned_untouched():
    silence = np.zeros((SR, 2))
    out, gain, report = control_crest(silence, SR)
    assert np.array_equal(out, silence)
    assert not report.engaged
    assert np.all(gain == 1.0)
    assert np.all(np.isfinite(out))


def test_empty_input_does_not_crash():
    empty = np.zeros((0, 2))
    out, _gain, report = control_crest(empty, SR)
    assert out.shape == empty.shape
    assert not report.engaged


def test_mono_input_keeps_its_shape_and_loses_crest():
    mix = _spiky_mix()[:, 0]
    before = measure_true_peak(mix, SR) - measure_integrated_lufs(mix, SR)
    out, gain, report = control_crest(mix, SR)
    assert out.ndim == 1
    assert out.shape == mix.shape
    assert report.engaged
    assert gain.shape == (mix.shape[0], 1)
    after = measure_true_peak(out, SR) - measure_integrated_lufs(out, SR)
    assert after < before - 5.0


def test_the_macro_ride_does_not_step():
    """A gain step on the ride would be audible as a pump on the fill."""
    mix = _spiky_mix()
    envelope = np.max(np.abs(mix), axis=1)
    ride, applied = _macro_gain(envelope, SR, -20.0, MAX_LEVEL_DB)
    assert applied > 6.0, "fixture should need a real ride"
    # A 250 ms Hann ramp across a ~10 dB move is far gentler than this bound.
    assert float(np.max(np.abs(np.diff(ride)))) < 5e-4
    assert float(np.min(ride)) > 0.0


def test_the_returned_gain_reproduces_the_output():
    """Stems ride the same curve, so it has to be the whole of the processing."""
    mix = _spiky_mix()
    out, gain, _report = control_crest(mix, SR)
    assert np.allclose(out, mix * gain, atol=1e-12)
