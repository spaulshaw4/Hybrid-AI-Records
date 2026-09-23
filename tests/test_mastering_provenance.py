"""Unit tests for Module 5 mastering bus + provenance guard."""
from __future__ import annotations

import os
import sys
import tempfile

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.mastering_bus import (  # noqa: E402
    MasteringBus,
    mono_sub_bass,
    phase_correlation,
    stereo_air_polish,
)
from engine.provenance_guard import (  # noqa: E402
    ProvenanceGuard,
    apply_uniqueness_drift,
    cosine_similarity,
    fingerprint_vector,
)
from engine.stem_packager import StemPackager, map_buses_to_delivery_stems  # noqa: E402
from dsp.true_peak_limiter import measure_true_peak_dbtp  # noqa: E402

SR = 44100


def _hot_stereo(n: int = SR // 2, amp: float = 1.2) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / SR
    left = amp * np.sin(2 * np.pi * 440.0 * t)
    right = amp * np.sin(2 * np.pi * 440.0 * t + 0.15)
    return np.column_stack((left, right))


def test_true_peak_limiting_clips_above_minus_one_dbtp():
    hot = _hot_stereo()
    raw_tp = measure_true_peak_dbtp(hot)
    assert raw_tp > -1.0

    mastered, report = MasteringBus(ceiling_dbtp=-1.0, lufs_tolerance=5.0).process(hot, SR)
    assert measure_true_peak_dbtp(mastered) <= -0.95
    assert report.true_peak_dbtp <= -0.95
    assert report.details.get("under_ceiling") is True


def test_phase_correlation_positive_after_stereo_widening():
    t = np.arange(SR, dtype=np.float64) / SR
    # Mostly correlated stereo with a little width.
    mid = 0.3 * np.sin(2 * np.pi * 220.0 * t)
    side = 0.05 * np.sin(2 * np.pi * 8000.0 * t)
    stereo = np.column_stack((mid + side, mid - side))
    polished = stereo_air_polish(stereo, SR, width=1.10)
    corr = phase_correlation(polished)
    assert corr > 0.2

    mastered, report = MasteringBus(side_width=1.10).process(stereo, SR)
    assert report.phase_correlation > 0.2
    assert phase_correlation(mastered) > 0.2


def test_mono_sub_collapses_low_side():
    t = np.arange(SR // 2, dtype=np.float64) / SR
    # Unequal but in-phase sub + shared mid — mono-sub should equalize L/R lows.
    sub = 0.4 * np.sin(2 * np.pi * 50.0 * t)
    mid = 0.2 * np.sin(2 * np.pi * 1000.0 * t)
    stereo = np.column_stack((mid + sub, mid + 0.25 * sub))
    out = mono_sub_bass(stereo, SR, cutoff_hz=90.0)
    from engine.dsp_utils import lowpass

    low_l = lowpass(out[:, 0], SR, 90.0)
    low_r = lowpass(out[:, 1], SR, 90.0)
    assert float(np.corrcoef(low_l, low_r)[0, 1]) > 0.95
    # Residual L/R delta in the sub band should be far smaller than the input imbalance.
    before = float(np.max(np.abs(lowpass(stereo[:, 0] - stereo[:, 1], SR, 90.0))))
    after = float(np.max(np.abs(low_l - low_r)))
    assert after < 0.35 * before


def test_mono_sub_side_rejection_is_24db_per_octave():
    t = np.arange(SR, dtype=np.float64) / SR
    side = 0.3 * np.sin(2 * np.pi * 45.0 * t)
    stereo = np.column_stack((side, -side))
    out = mono_sub_bass(stereo, SR, cutoff_hz=90.0)
    settled = slice(SR // 4, SR)
    side_out = 0.5 * (out[settled, 0] - out[settled, 1])
    ratio = float(np.sqrt(np.mean(side_out**2)) / np.sqrt(np.mean(side[settled] ** 2)))
    # One octave below cutoff: 2nd order gives ~-12 dB, 4th order ~-24 dB.
    assert ratio < 10 ** (-20.0 / 20.0)


def test_limiter_lookahead_ramp_has_no_gain_step():
    from dsp.true_peak_limiter import _lookahead_ramp

    window = 200
    # The limiter's target is a forward-window minimum, so each reduction is
    # held for at least ``window`` samples ending at the peak (index 1399).
    target = np.ones(3000)
    target[1200:1400] = 0.5
    ramped = _lookahead_ramp(target, window)
    assert float(ramped[1399]) <= 0.5 + 1e-12
    assert float(np.max(np.abs(np.diff(ramped)))) <= 0.5 / window + 1e-12


def test_mastering_push_is_capped_for_dynamic_material():
    n = SR * 4
    t = np.arange(n) / SR
    bed = 0.01 * np.sin(2 * np.pi * 220.0 * t)
    bed[:: SR // 4] += 0.95  # loud clicks over a quiet bed: huge crest factor
    x = np.column_stack((bed, bed))
    _m, report = MasteringBus().process(x, SR)
    from engine.mastering_bus import MAX_LIMITER_PUSH_DB

    assert MAX_LIMITER_PUSH_DB == 8.5
    assert report.details["limiter_push_db"] <= MAX_LIMITER_PUSH_DB + 1e-9
    assert report.details["limiter_push_capped"] is True


def test_loudness_gate_rejects_under_driven_master():
    from engine.mastering_bus import LoudnessComplianceError

    n = SR * 4
    t = np.arange(n) / SR
    bed = 0.01 * np.sin(2 * np.pi * 220.0 * t)
    bed[:: SR // 4] += 0.95  # crest factor far beyond the push cap
    x = np.column_stack((bed, bed))
    _m, report = MasteringBus().process(x, SR)  # reporting only
    assert report.details["within_lufs_window"] is False
    with pytest.raises(LoudnessComplianceError, match="failed broadcast loudness compliance") as info:
        MasteringBus(enforce_compliance=True).process(x, SR)
    assert info.value.push_capped is True
    assert info.value.final_lufs == pytest.approx(report.integrated_lufs, abs=1e-6)
    assert "max push 8.5 dB hit" in str(info.value)


def test_loudness_gate_passes_compliant_master():
    t = np.arange(SR * 3) / SR
    tone = 0.2 * np.sin(2 * np.pi * 220.0 * t) + 0.05 * np.sin(2 * np.pi * 110.0 * t)
    _m, report = MasteringBus(enforce_compliance=True).process(np.column_stack((tone, tone)), SR)
    assert abs(report.integrated_lufs + 14.0) <= 0.5


def test_provenance_drift_keeps_channels_and_stems_aligned():
    n = SR * 2
    rng = np.random.default_rng(11)
    left = 0.2 * rng.standard_normal(n)
    stereo = np.column_stack((left, left))
    drifted = apply_uniqueness_drift(stereo, SR, drift=0.02, seed=5)
    assert np.allclose(drifted[:, 0], drifted[:, 1])

    stems = {k: 0.2 * rng.standard_normal(n) for k in ("rhythm", "bass", "vocal")}
    master = sum(stems.values())
    guard = ProvenanceGuard(bpm=120.0, sr=SR, threshold=0.0)
    guard.register_reference(master, file_path="corpus/self.wav")
    m_out, s_out, report = guard.check(master, stems=stems, seed=3, auto_remediate=True)
    assert report.transforms_applied
    assert np.allclose(sum(s_out.values()), m_out, atol=1e-9)


def test_provenance_without_references_is_unverified():
    guard = ProvenanceGuard(bpm=120.0, sr=SR)
    _m, _s, report = guard.check(np.zeros(SR) + 0.01, stems={}, seed=0)
    assert report.certified is False
    assert report.details["status"] == "unverified_no_references"


def test_provenance_flags_identical_clone_and_passes_transformed():
    n = SR  # 1s ≈ enough for fingerprint
    t = np.arange(n, dtype=np.float64) / SR
    proprietary = 0.35 * (
        np.sin(2 * np.pi * 196.0 * t)
        + 0.5 * np.sin(2 * np.pi * 246.94 * t)
        + 0.25 * np.sin(2 * np.pi * 293.66 * t)
    )
    clone = proprietary.copy()

    guard = ProvenanceGuard(bpm=120.0, sr=SR, threshold=0.75)
    guard.register_reference(proprietary, file_path="corpus/clone_source.wav")

    # Identical clone must be flagged (pre-remediation path: auto_remediate False).
    _master, _stems, flagged_report = guard.check(
        clone, stems={"harmonic": clone}, seed=1, auto_remediate=False
    )
    assert flagged_report.max_similarity > 0.75
    assert flagged_report.certified is False
    assert flagged_report.flagged_segments

    # Transformed audio should pass.
    transformed = apply_uniqueness_drift(clone, SR, drift=0.02, seed=99)
    # Also add spectral noise so chromagram diverges further.
    transformed = transformed + 0.05 * np.random.default_rng(0).standard_normal(n)
    _m2, _s2, ok_report = guard.check(
        transformed, stems={"harmonic": transformed}, seed=2, auto_remediate=False
    )
    assert ok_report.max_similarity < flagged_report.max_similarity
    # Auto-remediate path on the clone should apply drift and certify or reduce similarity.
    rem_master, _rs, rem_report = guard.check(
        clone, stems={"harmonic": clone}, seed=3, auto_remediate=True
    )
    assert rem_report.transforms_applied
    assert rem_report.max_similarity <= flagged_report.max_similarity
    assert rem_master.shape == clone.shape
    # Fingerprints of identical buffers are near 1.0
    assert cosine_similarity(fingerprint_vector(proprietary, SR), fingerprint_vector(clone, SR)) > 0.99


def test_stem_packager_writes_manifest_and_zip():
    n = SR // 4
    mix = _hot_stereo(n, amp=0.4)
    stems = {
        "rhythm": mix[:, 0] * 0.5,
        "bass": mix[:, 0] * 0.4,
        "harmonic": mix[:, 0] * 0.3,
        "vocal": np.zeros(n),
    }
    delivery = map_buses_to_delivery_stems(stems)
    assert set(delivery) >= {
        "drums.wav",
        "bass.wav",
        "rhythm_guitar.wav",
        "lead_guitar.wav",
        "synth.wav",
        "vocals.wav",
    }
    mastered, report = MasteringBus().process(mix, SR)
    with tempfile.TemporaryDirectory() as tmp:
        packager = StemPackager(tmp, sr=SR)
        from engine.provenance_guard import ProvenanceReport
        from engine.stem_packager import export_delivery_bundle

        root, stems_root = export_delivery_bundle("ht_export_check", output_root=tmp)
        assert root.is_dir() and stems_root.is_dir()

        result = packager.package(
            master=mastered,
            stems=stems,
            song_plan={"title": "t", "bpm": 120, "genre_blend": {"spectral_aggression": 0.5}},
            mastering=report,
            provenance=ProvenanceReport(
                certified=True,
                max_similarity=0.1,
                threshold=0.75,
                certification_hash="abc",
            ),
            session_id="ht_test",
        )
        assert os.path.isfile(result.master_wav)
        assert os.path.isfile(result.manifest_path)
        assert os.path.isfile(result.zip_path)
        assert result.zip_path.endswith("ht_test_stems_bundle.zip")
        assert os.path.isdir(result.stems_dir)
        assert os.path.isfile(os.path.join(result.stems_dir, "drums.wav"))
        assert "master_url" in result.urls
        assert result.manifest.get("provenance_certification_hash") == "abc"
        assert result.manifest.get("provenance_similarity_score") == 0.1
        assert result.manifest["loudness"]["integrated_lufs"] is not None
        assert result.manifest["loudness"]["true_peak_dbtp"] is not None
        assert "song_plan" in result.manifest
        # Stems equal length to master
        import soundfile as sf

        m, _ = sf.read(result.master_wav, always_2d=True)
        for name in (
            "drums.wav",
            "bass.wav",
            "rhythm_guitar.wav",
            "lead_guitar.wav",
            "synth.wav",
            "vocals.wav",
        ):
            s, _ = sf.read(os.path.join(result.stems_dir, name), always_2d=True)
            assert s.shape[0] == m.shape[0]


def test_stem_packager_trims_hot_stems_uniformly():
    import soundfile as sf

    n = SR // 2
    t = np.arange(n) / SR
    drums = 1.5 * np.sin(2 * np.pi * 60.0 * t)  # +3.5 dBFS: would clip in PCM
    bass = 0.5 * np.sin(2 * np.pi * 50.0 * t)
    stems = {"rhythm": drums, "bass": bass, "harmonic": np.zeros(n), "vocal": np.zeros(n)}
    master = np.column_stack((0.5 * drums, 0.5 * drums))
    with tempfile.TemporaryDirectory() as tmp:
        result = StemPackager(tmp, sr=SR).package(master=master, stems=stems, session_id="ht_hot")
        d, _ = sf.read(os.path.join(result.stems_dir, "drums.wav"), always_2d=True)
        b, _ = sf.read(os.path.join(result.stems_dir, "bass.wav"), always_2d=True)
        assert float(np.max(np.abs(d))) <= 0.94 + 1e-4
        # Uniform trim keeps the 3:1 drums/bass balance.
        assert abs(float(np.max(np.abs(d))) / float(np.max(np.abs(b))) - 3.0) < 1e-3
        expected_db = round(20.0 * float(np.log10(0.94 / 1.5)), 3)
        assert result.manifest["stem_gain_db"] == pytest.approx(expected_db, abs=1e-3)

        quiet = StemPackager(os.path.join(tmp, "q"), sr=SR).package(
            master=master, stems={"bass": bass}, session_id="ht_quiet"
        )
        assert quiet.manifest["stem_gain_db"] == 0.0


def test_blueprint_finalize_writes_bus_stems_that_sum_to_mix():
    import soundfile as sf
    from engine.blueprint_track_assembler import _finalize_mix

    n = SR
    t = np.arange(n) / SR
    buses = {
        "rhythm": np.column_stack([0.8 * np.sin(2 * np.pi * 60 * t)] * 2),
        "bass": np.column_stack([0.7 * np.sin(2 * np.pi * 45 * t)] * 2),
        "harmonic": np.column_stack([0.4 * np.sin(2 * np.pi * 330 * t)] * 2),
        "vocal": np.column_stack([0.3 * np.sin(2 * np.pi * 440 * t)] * 2),
    }
    mix = sum(buses.values())  # peaks well above the -3 dBFS headroom target
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "ht_bus", "ht_bus_unmastered.wav")
        trace: dict = {}
        _finalize_mix(mix, SR, out, "ht_bus", tmp, None, -1.0, trace, bus_stems=buses)
        written, _ = sf.read(os.path.join(tmp, "ht_bus", "unmastered_mix.wav"), always_2d=True)
        bus_dir = os.path.join(tmp, "ht_bus", "bus_stems")
        summed = sum(
            sf.read(os.path.join(bus_dir, f"{b}.wav"), always_2d=True)[0] for b in buses
        )
        assert np.allclose(summed, written, atol=1e-5)
        assert trace["_bus_stems"]["gain"] < 1.0


def test_conductor_deliver_pipeline_smoke():
    from engine.local_song_conductor import deliver_conducted_track
    from engine.song_plan import GenreVector, GlobalSongPlan, SectionPlan

    plan = GlobalSongPlan(
        title="m5",
        key="E",
        scale="minor",
        bpm=120,
        total_bars=2,
        genre_blend=GenreVector(),
        sections=[
            SectionPlan(
                name="verse_1",
                start_bar=0,
                bars=2,
                energy_level=0.5,
                chord_progression=["Em", "C"],
                active_stems=["drums", "bass", "rhythm_guitar"],
                frequency_reservations={},
            )
        ],
        seed=1,
    )
    with tempfile.TemporaryDirectory() as tmp:
        out = deliver_conducted_track(
            {"song_plan": plan.model_dump(), "seed": 1},
            project_dir=tmp,
            sr=22050,
            session_id="ht_m5",
            index_db="/nonexistent/db.sqlite",
            require_corpus=False,
        )
        assert out["package"].zip_path and os.path.isfile(out["package"].zip_path)
        assert out["urls"].get("master_wav")
        assert out["mastering"].true_peak_dbtp <= -0.9
        assert "provenance" in out
