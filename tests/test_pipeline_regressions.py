"""End-to-end regressions for the failure modes found in the M1-M5 audit.

Each test pins one bug that previously shipped silently: stereo slices
flattened to half pitch, bar-grid drift, provenance desync, 404 delivery
URLs, harmonic false positives, and whole-song (not per-section) mixing.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.arrangement_assembler import ArrangementAssembler  # noqa: E402
from engine.provenance_guard import ProvenanceGuard, apply_uniqueness_drift  # noqa: E402
from engine.relational_mixer import apply_sectioned_relational_mix  # noqa: E402
from engine.song_evaluator import SongEvaluator, chord_pitch_classes  # noqa: E402
from engine.song_plan import (  # noqa: E402
    GenreVector,
    GlobalSongPlan,
    SectionPlan,
    beats_per_bar,
)
from engine.stem_retriever import key_within_tolerance  # noqa: E402

SR = 22050
PROGRESSION = ["Em", "C", "G", "D"]


def _section(name: str, start_bar: int, bars: int, stems: list[str], energy: float = 0.6) -> SectionPlan:
    return SectionPlan(
        name=name,
        start_bar=start_bar,
        bars=bars,
        energy_level=energy,
        chord_progression=list(PROGRESSION),
        active_stems=stems,
        frequency_reservations={},
    )


def _plan(sections: list[SectionPlan], *, bpm: int = 124, time_signature: str = "4/4") -> GlobalSongPlan:
    return GlobalSongPlan(
        title="regression",
        key="E",
        scale="minor",
        bpm=bpm,
        time_signature=time_signature,
        total_bars=sum(s.bars for s in sections),
        genre_blend=GenreVector(),
        sections=sections,
        seed=3,
    )


class _ToneRetriever:
    """Every family resolves to the same corpus file (loaded via load_audio)."""

    conn = object()

    def best_candidate(self, query):
        return {"file_path": "tone.wav", "estimated_bpm": 124.0, "detected_key": "E"}

    def close(self):
        pass


def _peak_hz(signal: np.ndarray, sr: int) -> float:
    seg = signal[: 1 << 14]
    spec = np.abs(np.fft.rfft(seg * np.hanning(seg.size)))
    return float(np.argmax(spec)) * sr / seg.size


# --- Test 1 -----------------------------------------------------------------

def test_stereo_corpus_slice_preserves_shape_and_pitch():
    t = np.arange(SR * 4) / SR
    stereo = np.column_stack(
        (0.4 * np.sin(2 * np.pi * 110.0 * t), 0.4 * np.sin(2 * np.pi * 110.0 * t + 0.7))
    )
    plan = _plan([_section("verse", 0, 8, ["bass"])])
    assembler = ArrangementAssembler(sr=SR, retriever=_ToneRetriever(), load_audio=lambda _p: stereo)
    bass = assembler.assemble(plan).tracks["bass"]
    assert bass.ndim == 2 and bass.shape[1] == 2
    for ch in (0, 1):
        assert abs(_peak_hz(bass[SR:, ch], SR) - 110.0) < 2.0
    # Channels keep their distinct phase (not collapsed to mono).
    assert not np.allclose(bass[:, 0], bass[:, 1])


# --- Test 2 -----------------------------------------------------------------

@pytest.mark.parametrize("time_signature", ["4/4", "3/4", "6/8"])
def test_arrangement_total_length_matches_bar_math(time_signature):
    sections = [
        _section("verse", 0, 8, ["drums", "bass"]),
        _section("pre_chorus", 8, 4, ["drums", "bass"]),
        _section("chorus", 12, 8, ["drums", "bass", "lead_vocal"]),
    ]
    bpm = 124
    plan = _plan(sections, bpm=bpm, time_signature=time_signature)
    result = ArrangementAssembler(sr=SR).assemble(plan)
    bpb = beats_per_bar(time_signature)
    lengths = [int(round((s.bars * bpb * 60.0 / bpm) * SR)) for s in sections]
    for bus, audio in result.tracks.items():
        assert audio.shape[0] == sum(lengths), f"{bus}: {audio.shape[0]} != {sum(lengths)}"
    starts = [s["start_sample"] for s in result.trace["sections"]]
    assert starts == [0, lengths[0], lengths[0] + lengths[1]]
    assert result.trace["beats_per_bar"] == bpb


# --- Test 3 -----------------------------------------------------------------

def test_provenance_drift_phase_and_stem_alignment():
    n = SR * 3
    rng = np.random.default_rng(21)
    mono = 0.2 * rng.standard_normal(n)
    drifted = apply_uniqueness_drift(np.column_stack((mono, mono)), SR, drift=0.02, seed=4)
    assert float(np.corrcoef(drifted[:, 0], drifted[:, 1])[0, 1]) > 0.98

    stems = {k: 0.2 * rng.standard_normal(n) for k in ("rhythm", "bass", "harmonic", "vocal")}
    master = sum(stems.values())
    guard = ProvenanceGuard(bpm=124.0, sr=SR, threshold=0.0)
    guard.register_reference(master, file_path="corpus/self.wav")
    m_out, s_out, report = guard.check(master, stems=stems, seed=11)
    assert report.transforms_applied, "remediation must run for this test"
    # Every stem drifted identically, so each still lines up with the master.
    rebuilt = sum(s_out.values())
    assert float(np.corrcoef(rebuilt, m_out)[0, 1]) > 0.98
    for name, audio in s_out.items():
        residual = m_out - (rebuilt - audio)
        assert float(np.corrcoef(residual, audio)[0, 1]) > 0.98, name


# --- Test 4 -----------------------------------------------------------------

def test_delivery_package_publication_roundtrip(tmp_path, monkeypatch):
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from api import headless_job_runner as runner
    from engine.stem_packager import STEM_FILES, StemPackager

    session = "ht_roundtrip01"
    assets = tmp_path / "assets"
    assets.mkdir()
    monkeypatch.setattr(runner, "ASSETS_ROOT", str(assets))
    monkeypatch.setattr(runner, "_API_LOG", str(tmp_path / "api.log"))
    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)

    n = SR
    t = np.arange(n) / SR
    tone = 0.3 * np.sin(2 * np.pi * 220.0 * t)
    master = np.column_stack((tone, tone))
    pkg_dir = tmp_path / "delivery"
    StemPackager(str(pkg_dir), sr=SR).package(
        master=master,
        stems={"rhythm": tone, "bass": tone * 0.5, "harmonic": tone * 0.4, "vocal": tone * 0.3},
        song_plan={"bpm": 124},
        session_id=session,
    )
    published = runner._publish_delivery_package(session, str(pkg_dir))
    urls = [published["master_url"], published["manifest_url"], published["zip_url"]]
    assert set(published["stem_urls"]) == set(STEM_FILES)
    urls += list(published["stem_urls"].values())

    client = TestClient(runner.app)
    for url in urls:
        response = client.get(url)
        assert response.status_code == 200, f"{url} -> {response.status_code}"
        assert len(response.content) > 0
    manifest = client.get(published["manifest_url"]).json()
    assert manifest["session_id"] == session
    assert client.get(published["zip_url"]).headers["content-type"] == "application/zip"


# --- Test 5 -----------------------------------------------------------------

def _stack(pcs, base_midi: int, harmonics: int = 1, seconds: float = 2.0, sr: int = 44100):
    t = np.arange(int(sr * seconds)) / sr
    out = np.zeros_like(t)
    for pc in pcs:
        f0 = 440.0 * 2.0 ** ((base_midi + pc - 69) / 12.0)
        out += sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, harmonics + 1))
    return 0.3 * out / len(pcs)


def _harmonic(signal: np.ndarray, sr: int = 44100) -> float:
    section = _section("verse", 0, 4, ["rhythm_guitar"])
    score = SongEvaluator(check_loudness=False).evaluate(
        signal, sr, stems={"harmonic": signal}, section=section, scan_sections=False
    )
    return score.harmonic_coherence


def test_harmonic_evaluator_power_chords_vs_noise():
    e5 = {4, 11}
    assert _harmonic(_stack(e5, base_midi=60)) >= 0.85
    # Guitar register (E2 + B2) with natural harmonics.
    assert _harmonic(_stack(e5, base_midi=36, harmonics=8)) >= 0.85
    progression = np.concatenate(
        [_stack(chord_pitch_classes(c), base_midi=60, seconds=0.5) for c in PROGRESSION]
    )
    assert _harmonic(progression) >= 0.80
    noise = 0.1 * np.random.default_rng(1).standard_normal(44100 * 2)
    assert _harmonic(noise) <= 0.05
    assert _harmonic(_stack({4, 5, 6, 8}, base_midi=60)) <= 0.05
    assert _harmonic(_stack(set(range(12)), base_midi=60)) <= 0.05


# --- Batch 4: per-section mixing, lead carve, plan propagation -------------

def _mid_band_rms(audio: np.ndarray, sr: int) -> float:
    from engine.dsp_utils import bandpass

    band = bandpass(audio, sr, 1000.0, 3500.0)
    return float(np.sqrt(np.mean(band * band)))


def test_per_section_mix_uses_each_sections_active_stems():
    per = SR * 2
    n = per * 2
    rng = np.random.default_rng(5)
    harmonic = 0.2 * rng.standard_normal(n)
    vocal = 0.2 * np.sin(2 * np.pi * 1800.0 * np.arange(n) / SR)
    windows = [
        ({"name": "intro", "active_stems": ["drums"], "energy_level": 0.3}, 0, per),
        ({"name": "verse", "active_stems": ["lead_vocal"], "energy_level": 0.7}, per, n),
    ]
    result = apply_sectioned_relational_mix(
        {"harmonic": harmonic, "vocal": vocal}, SR, windows
    )
    by_name = {m["section"]: m for m in result.meters["sections"]}
    assert by_name["intro"]["vocal_pocket_applied"] is False
    assert by_name["verse"]["vocal_pocket_applied"] is True
    dry = result.stems["harmonic"]
    # Compare carve depth away from the boundary and the verse warm-up.
    q = SR // 2
    intro_ratio = _mid_band_rms(dry[q : per - q], SR) / _mid_band_rms(harmonic[q : per - q], SR)
    verse_ratio = _mid_band_rms(dry[per + q : n - q], SR) / _mid_band_rms(harmonic[per + q : n - q], SR)
    assert verse_ratio < intro_ratio


def test_section_boundary_blend_has_no_level_swell():
    from engine.relational_mixer import apply_relational_mix

    n = SR * 2
    tone = 0.3 * np.sin(2 * np.pi * 220.0 * np.arange(n) / SR)
    same_rules = {"active_stems": ["drums"], "energy_level": 0.5}
    windows = [({"name": "a", **same_rules}, 0, n // 2), ({"name": "b", **same_rules}, n // 2, n)]
    sectioned = apply_sectioned_relational_mix({"harmonic": tone}, SR, windows).stems["harmonic"]
    single = apply_relational_mix({"harmonic": tone}, SR, section=windows[0][0]).stems["harmonic"]
    # Identical rules either side: the equal-gain seam reconstructs the signal
    # exactly (an equal-power seam would swell up to +3 dB here).
    assert np.allclose(sectioned, single, atol=1e-9)


def test_lead_bus_triggers_mid_carve_without_vocal():
    n = SR * 2
    rng = np.random.default_rng(8)
    harmonic = 0.2 * rng.standard_normal(n)
    lead = 0.25 * np.sin(2 * np.pi * 2000.0 * np.arange(n) / SR)
    windows = [({"name": "solo", "active_stems": ["drums", "lead_guitar"], "energy_level": 0.9}, 0, n)]
    result = apply_sectioned_relational_mix(
        {"harmonic": harmonic, "lead": lead, "vocal": np.zeros(n)}, SR, windows
    )
    section = result.meters["sections"][0]
    assert section["vocal_pocket_applied"] is True
    assert section["pocket_keyed_by"] == ["lead"]
    assert _mid_band_rms(result.stems["harmonic"], SR) < _mid_band_rms(harmonic, SR)


def test_lead_families_render_on_dedicated_lead_bus():
    t = np.arange(SR * 4) / SR
    tone = np.column_stack([0.3 * np.sin(2 * np.pi * 330.0 * t)] * 2)
    plan = _plan([_section("solo", 0, 4, ["drums", "lead_guitar"])])
    tracks = ArrangementAssembler(sr=SR, retriever=_ToneRetriever(), load_audio=lambda _p: tone).assemble(
        plan
    ).tracks
    assert float(np.max(np.abs(tracks["lead"]))) > 0.1
    assert float(np.max(np.abs(tracks["harmonic"]))) == 0.0


def test_scale_accepts_relative_major_root_without_pitch_shift():
    assert key_within_tolerance("G", "E", scale="minor") == (True, 0)
    assert key_within_tolerance("C#", "E", scale="major") == (True, 0)
    ok, _ = key_within_tolerance("G", "E")  # no scale: +3 st is out of tolerance
    assert ok is False


# --- Batch 5: vectorised envelopes / limiter, index migration --------------

def _follow_gain_loop(target, rc):
    out = np.empty_like(target)
    current = 1.0
    for i, wanted in enumerate(target):
        current = wanted if wanted < current else wanted + rc * (current - wanted)
        out[i] = current
    return out


def _peak_hold_loop(signal, rc):
    out = np.empty_like(signal)
    state = 0.0
    for i, sample in enumerate(np.abs(signal)):
        state = sample if sample >= state else state * rc + sample * (1.0 - rc)
        out[i] = state
    return out


@pytest.mark.parametrize("rc", [0.0, 0.5, 0.9, 0.999, 0.99999, 1.0])
def test_vectorised_follow_gain_matches_sample_loop(rc):
    from dsp.true_peak_limiter import _follow_gain

    rng = np.random.default_rng(int(rc * 1000))
    # Long enough to span several scaled-min blocks for small rc.
    target = np.clip(1.0 - np.abs(rng.standard_normal(20000)) * 0.3, 0.05, 1.0)
    target[5000:5200] = 0.2
    assert np.allclose(_follow_gain(target, rc), _follow_gain_loop(target, rc), atol=1e-9)


@pytest.mark.parametrize("rc", [0.0, 0.3, 0.97, 0.9995, 1.0])
def test_vectorised_peak_hold_matches_sample_loop(rc):
    from engine.dsp_utils import peak_hold

    rng = np.random.default_rng(7)
    signal = rng.standard_normal(20000) * np.repeat(rng.uniform(0.05, 1.0, 40), 500)
    assert np.allclose(peak_hold(signal, rc), _peak_hold_loop(signal, rc), atol=1e-9)


@pytest.mark.parametrize("window", [1, 2, 7, 64, 881])
def test_forward_window_max_matches_sliding_reference(window):
    from numpy.lib.stride_tricks import sliding_window_view

    from dsp.true_peak_limiter import _forward_window_max

    env = np.abs(np.random.default_rng(window).standard_normal(5000))
    padded = np.pad(env, (0, window - 1), mode="edge")
    reference = np.max(sliding_window_view(padded, window), axis=1)[: env.size] if window > 1 else env
    assert np.array_equal(_forward_window_max(env, window), reference)


def test_limiter_holds_ceiling_without_gain_steps():
    from dsp.true_peak_limiter import apply_true_peak_limiter, measure_true_peak_dbtp

    sr = 44100
    t = np.arange(sr * 2) / sr
    carrier = 0.5 * np.sin(2 * np.pi * 220.0 * t)
    carrier[sr // 2 : sr // 2 + 200] *= 3.0  # +9.5 dB transient burst
    stereo = np.column_stack((carrier, carrier))
    out = apply_true_peak_limiter(stereo, sr=sr, ceiling_dbtp=-1.0)
    assert out.shape == stereo.shape
    assert measure_true_peak_dbtp(out) <= -1.0 + 1e-6
    # Recover the applied gain (out / in) where the carrier is well above zero.
    mask = np.abs(stereo[:, 0]) > 0.2
    idx = np.flatnonzero(mask)
    gain = np.interp(np.arange(stereo.shape[0]), idx, out[idx, 0] / stereo[idx, 0])
    # 5 ms look-ahead ramp: no single-sample gain jump bigger than ~1 %.
    assert float(np.max(np.abs(np.diff(gain)))) < 0.01


def test_mastering_85s_runs_in_a_few_seconds():
    import time as _time

    from engine.mastering_bus import MasteringBus

    sr = 44100
    n = sr * 85
    rng = np.random.default_rng(9)
    t = np.arange(n) / sr
    tone = 0.15 * np.sin(2 * np.pi * 110.0 * t) + 0.05 * rng.standard_normal(n)
    kicks = np.zeros(n)
    kicks[:: sr // 2] = 0.9
    mono = tone + np.convolve(kicks, np.exp(-np.arange(2000) / 300.0))[:n]
    stereo = np.column_stack((mono, mono * 0.95))
    start = _time.perf_counter()
    _master, report = MasteringBus().process(stereo, sr)
    elapsed = _time.perf_counter() - start
    # Was ~20 s (sample loops + O(n*w) window max + cascaded re-limiting).
    assert elapsed < 8.0, f"mastering took {elapsed:.1f}s"
    assert abs(report.integrated_lufs + 14.0) <= 0.5 or report.details["limiter_push_capped"]
    assert report.true_peak_dbtp <= -1.0 + 1e-6


def test_slice_index_migration_creates_used_index(tmp_path):
    import sqlite3

    sys.path.insert(0, os.path.join(_REPO, "db"))
    from migrate_slice_index import INDEX_NAME, run_migration

    db = tmp_path / "catalog.sqlite"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE slice_index (id INTEGER PRIMARY KEY, file_path TEXT, filename TEXT, "
        "stem_type TEXT, detected_key TEXT, estimated_bpm REAL, rms_db REAL, "
        "spectral_centroid REAL, tags TEXT, duration_sec REAL)"
    )
    rng = np.random.default_rng(3)
    rows = [
        (f"/c/{i}.wav", f"s{i}.wav", ("rhythm", "harmonic", "vocal")[i % 3], "E",
         float(rng.uniform(60, 200)), float(rng.uniform(-40, -10)), 2000.0, "", 4.0)
        for i in range(5000)
    ]
    conn.executemany(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, estimated_bpm, "
        "rms_db, spectral_centroid, tags, duration_sec) VALUES (?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()
    first = run_migration(str(db))
    assert first["created"] is True and first["rows"] == 5000
    assert first["uses_index"], first["plan"]
    again = run_migration(str(db))
    assert again["created"] is False
    conn = sqlite3.connect(db)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    conn.close()
    assert INDEX_NAME in names


def test_conductor_mix_is_sectioned_when_plan_has_bars():
    from engine.local_song_conductor import mix_conducted_stems

    plan = _plan(
        [_section("verse", 0, 2, ["drums", "bass"]), _section("chorus", 2, 2, ["lead_vocal"])]
    )
    n = int(round(4 * 4 * 60.0 / plan.bpm * SR))
    rng = np.random.default_rng(2)
    stems = {bus: 0.1 * rng.standard_normal((n, 2)) for bus in ("rhythm", "bass", "harmonic", "vocal")}
    result = mix_conducted_stems(stems, {"song_plan": plan.model_dump()}, sr=SR)
    assert result.meters["sectioned"] is True
    assert [m["section"] for m in result.meters["sections"]] == ["verse", "chorus"]
    assert result.meters["sections"][1]["vocal_pocket_applied"] is True
    assert result.meters["sections"][0]["vocal_pocket_applied"] is False
