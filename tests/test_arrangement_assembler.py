"""Unit tests for Module 4 arrangement assembly + stem retrieval."""
from __future__ import annotations

import os
import sqlite3
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.arrangement_assembler import ArrangementAssembler  # noqa: E402
from engine.song_plan import GenreVector, GlobalSongPlan, SectionPlan  # noqa: E402
from engine.stem_adapter import StemAdapter, enforce_length, section_sample_count  # noqa: E402
from engine.stem_retriever import (  # noqa: E402
    StemCandidateQuery,
    SQLiteStemRetriever,
    bpm_within_tolerance,
    build_stem_sql,
    filter_candidates,
    key_within_tolerance,
)

SR = 22050  # faster tests


def _make_plan() -> GlobalSongPlan:
    return GlobalSongPlan(
        title="m4_test",
        key="E",
        scale="minor",
        bpm=120,
        total_bars=4,
        genre_blend=GenreVector(
            harmonic_complexity=0.4,
            rhythmic_syncopation=0.5,
            spectral_aggression=0.5,
            dynamic_headroom=0.5,
            spatial_depth=0.4,
        ),
        sections=[
            SectionPlan(
                name="verse_1",
                start_bar=0,
                bars=2,
                energy_level=0.4,
                chord_progression=["Em", "C"],
                active_stems=["drums", "bass", "rhythm_guitar"],
                frequency_reservations={},
            ),
            SectionPlan(
                name="chorus_1",
                start_bar=2,
                bars=2,
                energy_level=0.85,
                chord_progression=["Em", "G"],
                active_stems=["drums", "bass", "rhythm_guitar", "lead_vocal"],
                frequency_reservations={},
            ),
        ],
        seed=7,
    )


def _memory_index() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE slice_index (
            id INTEGER PRIMARY KEY,
            file_path TEXT,
            filename TEXT,
            stem_type TEXT,
            detected_key TEXT,
            estimated_bpm REAL,
            rms_db REAL,
            spectral_centroid REAL,
            tags TEXT,
            duration_sec REAL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE slice_history (
            file_path TEXT PRIMARY KEY,
            last_used TEXT,
            use_count INTEGER DEFAULT 0
        )
        """
    )
    rows = [
        # in-tolerance rhythm @ 120 E
        ("/fake/drums_a.wav", "drums_a.wav", "rhythm", "E", 120.0, -18.0, 3200.0),
        # BPM 8% high still ok (129.6)
        ("/fake/drums_b.wav", "drums_b.wav", "rhythm", "E", 129.0, -16.0, 3000.0),
        # BPM too far (150)
        ("/fake/drums_far.wav", "drums_far.wav", "rhythm", "E", 150.0, -16.0, 3000.0),
        # key +2 semitones (F#) — allowed
        ("/fake/drums_fs.wav", "drums_fs.wav", "rhythm", "F#", 120.0, -17.0, 3100.0),
        # key +3 (G) — rejected by ±2 filter
        ("/fake/drums_g.wav", "drums_g.wav", "rhythm", "G", 120.0, -17.0, 3100.0),
        # bass by filename token
        ("/fake/bass_s4_01.wav", "bass_s4_01.wav", "harmonic", "E", 118.0, -20.0, 200.0),
        # harmonic guitar-ish
        ("/fake/other_gtr.wav", "other_gtr.wav", "harmonic", "E", 122.0, -19.0, 1800.0),
        # vocal
        ("/fake/vocals_01.wav", "vocals_01.wav", "vocal", "E", 120.0, -22.0, 2500.0),
        # dead air
        ("/fake/dead.wav", "dead.wav", "rhythm", "E", 120.0, -80.0, 100.0),
    ]
    for path, name, stem, key, bpm, rms, cen in rows:
        conn.execute(
            "INSERT INTO slice_index "
            "(file_path, filename, stem_type, detected_key, estimated_bpm, rms_db, "
            "spectral_centroid, tags, duration_sec) VALUES (?,?,?,?,?,?,?,?,?)",
            (path, name, stem, key, bpm, rms, cen, "", 2.0),
        )
    conn.commit()
    return conn


def test_build_stem_sql_returns_parameterized_query():
    q = StemCandidateQuery(
        instrument_family="drums",
        target_bpm=120,
        target_key="E",
        target_chord="Em",
        energy_tier=0.5,
        genre_vector=GenreVector(),
    )
    sql, params = build_stem_sql(q, fetch_limit=50)
    assert "slice_index" in sql
    assert "si.stem_type = ?" in sql
    assert "LIMIT ?" in sql
    assert params[-1] == 50
    assert "rhythm" in params


def test_sql_query_builder_candidates_within_bpm_key_tolerance():
    conn = _memory_index()
    q = StemCandidateQuery(
        instrument_family="drums",
        target_bpm=120,
        target_key="E",
        target_chord="Em",
        energy_tier=0.5,
        genre_vector=GenreVector(),
    )
    sql, params = build_stem_sql(q, fetch_limit=100)
    rows = conn.execute(sql, params).fetchall()
    keys = (
        "file_path", "filename", "stem_type", "detected_key", "estimated_bpm",
        "rms_db", "spectral_centroid", "duration_sec",
    )
    mapped = [dict(zip(keys, row)) for row in rows]
    # Dead air excluded by SQL rms filter; far BPM may still be in wide SQL band.
    names = {r["filename"] for r in mapped}
    assert "dead.wav" not in names
    assert "drums_a.wav" in names

    filtered = filter_candidates(mapped, q)
    filenames = {r["filename"] for r in filtered}
    assert "drums_a.wav" in filenames
    assert "drums_b.wav" in filenames  # ~7.5% high
    assert "drums_far.wav" not in filenames
    assert "drums_fs.wav" in filenames  # +2 st
    assert "drums_g.wav" not in filenames  # +3 st
    for row in filtered:
        assert bpm_within_tolerance(row["estimated_bpm"], 120.0) or row["estimated_bpm"] is None
        ok, shift = key_within_tolerance(row["detected_key"], "E")
        assert ok and abs(shift) <= 2


def test_retriever_best_candidate_with_memory_db():
    conn = _memory_index()
    retriever = SQLiteStemRetriever(conn=conn, require_on_disk=False)
    q = StemCandidateQuery(
        instrument_family="bass",
        target_bpm=120,
        target_key="E",
        target_chord="Em",
        energy_tier=0.5,
        genre_vector=GenreVector(),
    )
    hit = retriever.best_candidate(q)
    assert hit is not None
    assert "bass" in hit["filename"]


def test_sample_length_alignment_across_sections():
    plan = _make_plan()
    assembler = ArrangementAssembler(
        sr=SR,
        retriever=SQLiteStemRetriever(conn=None, require_on_disk=False),
    )
    result = assembler.assemble(plan)
    bpm = plan.bpm
    expected = sum(section_sample_count(s.bars, bpm, SR) for s in plan.sections)
    # Seam crossfades consume rendered tails, so length equals exact bar math.
    for bus, audio in result.tracks.items():
        assert audio.shape[0] == expected, f"{bus} length mismatch"
        assert audio.ndim == 2 and audio.shape[1] == 2, f"{bus} not stereo"
    starts = [s["start_sample"] for s in result.trace["sections"]]
    grid = [sum(section_sample_count(s.bars, bpm, SR) for s in plan.sections[:i])
            for i in range(len(plan.sections))]
    assert starts == grid
    # Per-section adapted length exact before stitch.
    adapter = StemAdapter(SR)
    for section in plan.sections:
        n = adapter.target_length(section.bars, bpm)
        tone = np.sin(2 * np.pi * 110.0 * np.arange(n + 500) / SR)
        out, info = adapter.adapt(
            tone,
            bars=section.bars,
            target_bpm=bpm,
            target_key="E",
            source_bpm=bpm,
            source_key="E",
        )
        assert out.shape[0] == n
        assert info["target_samples"] == n


def test_crossfade_boundaries_have_no_dropouts_or_clicks():
    plan = _make_plan()
    assembler = ArrangementAssembler(
        sr=SR,
        retriever=SQLiteStemRetriever(conn=None, require_on_disk=False),
        xfade_ms=20.0,
    )
    assembler._retriever.conn = None
    tracks = assembler.build_arrangement(plan)
    fade = max(1, int(round(SR * 20.0 / 1000.0)))
    # Section 2 starts exactly on the barline; the fade ends there.
    first_n = section_sample_count(plan.sections[0].bars, plan.bpm, SR)
    boundary = first_n
    for bus, audio in tracks.items():
        if bus == "vocal" and float(np.sqrt(np.mean(audio * audio))) < 1e-5:
            continue
        if float(np.sqrt(np.mean(audio * audio))) < 1e-6:
            continue
        # Window around the join: energy must stay continuous (no hard zero gap).
        lo = max(0, boundary - fade)
        hi = min(audio.shape[0], boundary + fade)
        region = audio[lo:hi]
        assert region.size > 0
        # Equal-power fade keeps RMS above a floor of the abutting section levels.
        left = audio[max(0, boundary - fade) : boundary]
        right = audio[boundary : min(audio.shape[0], boundary + fade)]
        left_rms = float(np.sqrt(np.mean(left * left) + 1e-12))
        right_rms = float(np.sqrt(np.mean(right * right) + 1e-12))
        mid = audio[boundary : min(audio.shape[0], boundary + max(1, fade // 4))]
        mid_rms = float(np.sqrt(np.mean(mid * mid) + 1e-12))
        floor = 0.25 * min(left_rms, right_rms)
        assert mid_rms >= floor, f"{bus} energy collapse at crossfade"
        # Phase click proxy: sample-to-sample jump bounded vs local RMS.
        if region.size > 4:
            diff = np.abs(np.diff(region))
            local_rms = float(np.sqrt(np.mean(region * region)) + 1e-9)
            assert float(np.max(diff)) < 8.0 * local_rms + 0.15


def test_enforce_length_pad_and_trim():
    x = np.ones(100)
    assert enforce_length(x, 80).shape[0] == 80
    assert enforce_length(x, 150).shape[0] == 150


def test_enforce_length_loop_mode_has_no_trailing_silence():
    x = 0.5 * np.sin(2 * np.pi * 220.0 * np.arange(SR) / SR)
    out = enforce_length(x, SR * 5, loop=True, sr=SR)
    assert out.shape[0] == SR * 5
    tail = out[-SR // 2 :]
    assert float(np.sqrt(np.mean(tail * tail))) > 0.2


def test_tile_loop_repeats_start_exactly_on_period():
    from engine.stem_adapter import tile_loop_on_grid

    period, fade = 1000, 50
    half = fade // 2
    body = np.zeros((period + fade + half, 2))
    body[half] = 1.0  # loop point (zc_radius=0 → exactly the pre-roll length)
    out = tile_loop_on_grid(body, period * 4, period=period, fade=fade)
    onsets = np.flatnonzero(np.abs(out[:, 0]) > 0.5)
    assert onsets.tolist() == [0, period, 2 * period, 3 * period]
    # First repeat at unity; later onsets sit mid-way through the centred
    # sin/cos equal-power join.
    assert out[0, 0] == pytest.approx(1.0)
    mid = float(np.sin(0.5 * np.pi * half / (fade - 1)))
    assert out[period, 0] == pytest.approx(mid, abs=1e-9)
    assert np.allclose(out[:, 0], out[:, 1])


def test_tile_loop_joins_are_click_free():
    from engine.stem_adapter import tile_loop_on_grid

    tone = 0.5 * np.sin(2 * np.pi * 220.0 * np.arange(SR) / SR)
    zc = int(round(SR * 0.015))
    out = tile_loop_on_grid(tone, SR * 4, period=SR // 2 + 137, fade=441, zc_radius=zc)
    body_step = float(np.max(np.abs(np.diff(tone))))
    assert float(np.max(np.abs(np.diff(out)))) < 2.5 * body_step


def _query(family: str, bpm: int = 120) -> StemCandidateQuery:
    return StemCandidateQuery(
        instrument_family=family,
        target_bpm=bpm,
        target_key="E",
        target_chord="Em",
        energy_tier=0.5,
        genre_vector=GenreVector(),
    )


def test_bpm_window_is_applied_in_sql_before_limit():
    conn = _memory_index()
    # 50 alphabetically-first rows far off tempo would fill LIMIT under the old
    # ORDER BY file_path LIMIT N fetch; in-tempo rows sort last by path.
    for i in range(50):
        conn.execute(
            "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, "
            "estimated_bpm, rms_db, spectral_centroid, tags, duration_sec) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (f"/aaa/off_{i:02d}.wav", f"off_{i:02d}.wav", "rhythm", "E", 175.0, -18.0, 3000.0, "", 4.0),
        )
    conn.execute(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, "
        "estimated_bpm, rms_db, spectral_centroid, tags, duration_sec) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        ("/zzz/half_time.wav", "half_time.wav", "rhythm", "E", 60.0, -18.0, 3000.0, "", 4.0),
    )
    sql, params = build_stem_sql(_query("drums"), fetch_limit=5)
    rows = conn.execute(sql, params).fetchall()
    bpms = [r[4] for r in rows]
    assert rows and all(
        any(abs(b * m - 120.0) <= 120.0 * 0.08 + 1e-9 for m in (1.0, 2.0, 0.5)) for b in bpms
    )
    names = {r[1] for r in rows}
    assert "half_time.wav" in names  # half-time window
    assert not any(n.startswith("off_") for n in names)
    assert bpms[0] == 120.0  # nearest tempo ranks first


def test_vocal_rows_without_bpm_stay_eligible_but_rank_last():
    conn = _memory_index()
    conn.execute(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, "
        "estimated_bpm, rms_db, spectral_centroid, tags, duration_sec) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        ("/aaa/vocal_nobpm.wav", "vocal_nobpm.wav", "vocal", "E", None, -22.0, 2500.0, "", 4.0),
    )
    sql, params = build_stem_sql(_query("vocal"), fetch_limit=10)
    names = [r[1] for r in conn.execute(sql, params).fetchall()]
    assert names == ["vocals_01.wav", "vocal_nobpm.wav"]
    # Non-vocal roles never admit NULL BPM.
    sql, params = build_stem_sql(_query("drums"), fetch_limit=100)
    assert all(r[4] is not None for r in conn.execute(sql, params).fetchall())


def test_retriever_reports_bpm_index_state_once(capsys, monkeypatch):
    import engine.stem_retriever as sr_mod
    from engine.stem_selector import BPM_INDEX_DDL

    monkeypatch.setattr(sr_mod, "_BPM_INDEX_REPORTED", set())
    conn = _memory_index()
    SQLiteStemRetriever(conn=conn, require_on_disk=False)
    out = capsys.readouterr().out
    assert "has no BPM index" in out and "migrate_slice_index.py" in out
    SQLiteStemRetriever(conn=conn, require_on_disk=False)
    assert capsys.readouterr().out == ""  # reported once per catalog

    conn.execute(BPM_INDEX_DDL)
    SQLiteStemRetriever(conn=conn, require_on_disk=False)
    assert "idx_slice_index_bpm present" in capsys.readouterr().out


def test_require_corpus_raises_for_missing_critical_stem():
    assembler = ArrangementAssembler(
        sr=SR,
        retriever=SQLiteStemRetriever(conn=None, require_on_disk=False),
        require_corpus=True,
    )
    with pytest.raises(RuntimeError, match="critical stem 'drums'.*no_index"):
        assembler.assemble(_make_plan())


class _FailingLoadRetriever:
    conn = object()

    def best_candidate(self, query):
        return {"file_path": f"/missing/{query.instrument_family}.wav"}

    def close(self):
        pass


def test_load_failures_are_flagged_not_swallowed():
    def boom(path):
        raise OSError(f"cannot open {path}")

    assembler = ArrangementAssembler(sr=SR, retriever=_FailingLoadRetriever(), load_audio=boom)
    result = assembler.assemble(_make_plan())
    flagged = result.trace["non_corpus_stems"]
    assert flagged and all(item["synthetic"] for item in flagged)
    assert all("load_failed" in item["reason"] and "cannot open" in item["reason"] for item in flagged)
    first = result.trace["sections"][0]["stems"]["drums"]
    assert first["synthetic"] is True and "load_failed" in first["synthetic_reason"]

    strict = ArrangementAssembler(
        sr=SR, retriever=_FailingLoadRetriever(), load_audio=boom, require_corpus=True
    )
    with pytest.raises(RuntimeError, match="load_failed"):
        strict.assemble(_make_plan())


class _DrumsBassGuitarOnlyRetriever:
    conn = object()

    def best_candidate(self, query):
        if query.instrument_family == "vocal":
            return None
        return {"file_path": "ok.wav", "estimated_bpm": 120.0, "detected_key": "E"}

    def close(self):
        pass


def test_require_corpus_silences_optional_stems_instead_of_sine():
    tone = 0.2 * np.sin(2 * np.pi * 110.0 * np.arange(SR * 4) / SR)
    assembler = ArrangementAssembler(
        sr=SR,
        retriever=_DrumsBassGuitarOnlyRetriever(),
        load_audio=lambda _p: tone,
        require_corpus=True,
    )
    result = assembler.assemble(_make_plan())
    assert float(np.max(np.abs(result.tracks["vocal"]))) == 0.0
    flagged = result.trace["non_corpus_stems"]
    assert [f["family"] for f in flagged] == ["vocal"]
    assert flagged[0]["synthetic"] is False and "no_candidate" in flagged[0]["reason"]


class _StereoRetriever:
    conn = object()

    def best_candidate(self, query):
        return {
            "file_path": "stereo.wav",
            "estimated_bpm": 120.0,
            "detected_key": "E",
            "pitch_shift_semitones": 0,
        }

    def close(self):
        pass


def test_stereo_slices_keep_channels_and_pitch():
    t = np.arange(SR * 4) / SR
    stereo = np.column_stack((0.4 * np.sin(2 * np.pi * 110.0 * t), np.zeros_like(t)))
    plan = _make_plan()
    assembler = ArrangementAssembler(
        sr=SR, retriever=_StereoRetriever(), load_audio=lambda _p: stereo
    )
    bass = assembler.assemble(plan).tracks["bass"]
    assert bass.ndim == 2 and bass.shape[1] == 2
    assert float(np.max(np.abs(bass[:, 1]))) < 1e-9
    seg = bass[2000 : 2000 + 8192, 0]
    spec = np.abs(np.fft.rfft(seg * np.hanning(seg.size)))
    peak_hz = float(np.argmax(spec)) * SR / seg.size
    assert abs(peak_hz - 110.0) < 4.0


def test_short_slice_loops_across_section_without_silence():
    # 2.3 s slice in 2-bar (4 s) sections: previously the last ~1.7 s was silence.
    t = np.arange(int(SR * 2.3)) / SR
    stereo = np.column_stack([0.3 * np.sin(2 * np.pi * 220.0 * t)] * 2)
    plan = _make_plan()
    assembler = ArrangementAssembler(
        sr=SR, retriever=_StereoRetriever(), load_audio=lambda _p: stereo
    )
    drums = assembler.assemble(plan).tracks["rhythm"]
    win = SR // 20
    rms = [
        float(np.sqrt(np.mean(drums[i : i + win] ** 2)))
        for i in range(0, drums.shape[0] - win, win)
    ]
    assert min(rms) > 0.05, "silent gap inside a looped section"


def test_conductor_build_arrangement_tracks_pipes_to_mixer_shape():
    from engine.local_song_conductor import build_arrangement_tracks, mix_conducted_stems

    plan = _make_plan()
    # Synthetic-only assembler path via assemble_conducted_tracks with no DB.
    from engine.local_song_conductor import assemble_conducted_tracks

    # Monkey: assemble with null retriever by calling ArrangementAssembler directly
    # through build helper — index_db missing yields synth fallback.
    assembly = assemble_conducted_tracks(
        plan, sr=SR, index_db="/nonexistent/no.db", require_corpus=False
    )
    tracks = assembly.tracks
    assert set(tracks) >= {"rhythm", "bass", "harmonic", "vocal"}
    mixed = mix_conducted_stems(
        tracks,
        {"song_plan": plan.model_dump()},
        sr=SR,
    )
    assert mixed.mix.size > 0
    assert "rhythm" in mixed.stems
