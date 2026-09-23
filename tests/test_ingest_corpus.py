"""Standalone ingester: archive unpack ledger, feature backfill, relabel."""
from __future__ import annotations

import io
import os
import sqlite3
import sys
import tarfile
import zipfile

import numpy as np
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from db.index_578gb_corpus import infer_stem_type  # noqa: E402
from scripts import ingest_corpus as ing  # noqa: E402

SR = 22050


def _click_track(path, bpm=120.0, seconds=4.0, freq=220.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    audio = 0.05 * np.sin(2 * np.pi * freq * t)
    step = int(SR * 60.0 / bpm)
    for i in range(0, n, step):
        end = min(n, i + 400)
        audio[i:end] += np.linspace(0.8, 0.0, end - i)
    sf.write(str(path), audio, SR, subtype="PCM_16")


def _catalog(tmp_path, rows):
    db = tmp_path / "catalog.sqlite"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE slice_index (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT UNIQUE, "
        "filename TEXT, stem_type TEXT, detected_key TEXT, estimated_bpm REAL, rms_db REAL, "
        "spectral_centroid REAL, tags TEXT, duration_sec REAL)"
    )
    conn.executemany(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, estimated_bpm, duration_sec) "
        "VALUES (?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()
    return str(db)


def test_layer_folder_beats_phrase_keyword():
    assert infer_stem_type(r"d:\musicdatasets\corpus_4s\harmonic\123_phrase_0011.wav") == "harmonic"
    assert infer_stem_type(r"d:\musicdatasets\corpus_4s\vocal\take_phrase_0001.wav") == "vocal"
    assert infer_stem_type(r"d:\packs\misc\hook_phrase.wav") == "vocal"


def test_features_backfill_fills_only_nulls_and_is_resumable(tmp_path):
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    _click_track(a, bpm=120.0)
    _click_track(b, bpm=100.0)
    db = _catalog(
        tmp_path,
        [
            (str(a), "a.wav", "harmonic", None, None, None),
            (str(b), "b.wav", "rhythm", "D", 99.0, None),
            (str(tmp_path / "gone.wav"), "gone.wav", "harmonic", None, None, None),
        ],
    )
    conn = ing.connect(db)
    stats = ing.run_features(conn, workers=1, batch=2, limit=0, dry_run=False)
    assert stats["updated"] == 2 and stats["failed"] == 1
    rows = {r[0]: r[1:] for r in conn.execute(
        "SELECT filename, detected_key, estimated_bpm, duration_sec FROM slice_index")}
    assert rows["a.wav"][0] is not None
    assert 110.0 <= rows["a.wav"][1] <= 130.0 or 55.0 <= rows["a.wav"][1] <= 65.0
    assert rows["a.wav"][2] == 4.0
    # Existing values are never overwritten.
    assert rows["b.wav"][0] == "D" and rows["b.wav"][1] == 99.0
    assert conn.execute("SELECT error FROM ingest_feature_failures").fetchone()[0] == "missing file"
    # Second run finds nothing left to do.
    again = ing.run_features(conn, workers=1, batch=2, limit=0, dry_run=False)
    assert again == {"updated": 0, "failed": 0, "no_tempo": 0}
    conn.close()


def test_silent_slice_keeps_key_and_bpm_null(tmp_path):
    silent = tmp_path / "silent.wav"
    sf.write(str(silent), np.zeros(SR * 4), SR)
    db = _catalog(tmp_path, [(str(silent), "silent.wav", "harmonic", None, None, None)])
    conn = ing.connect(db)
    ing.run_features(conn, workers=1, batch=10, limit=0, dry_run=False)
    key, bpm, dur = conn.execute(
        "SELECT detected_key, estimated_bpm, duration_sec FROM slice_index").fetchone()
    assert key is None and bpm is None and dur == 4.0
    assert ing.run_features(conn, workers=1, batch=10, limit=0, dry_run=False)["updated"] == 0
    conn.close()


def _wav_bytes():
    buf = io.BytesIO()
    sf.write(buf, np.zeros(1000), SR, format="WAV")
    return buf.getvalue()


def test_unpack_extracts_audio_only_blocks_traversal_and_skips_unchanged(tmp_path):
    inbox, packs = tmp_path / "incoming_zips", tmp_path / "raw_packs"
    inbox.mkdir()
    with zipfile.ZipFile(inbox / "Pack One.zip", "w") as z:
        z.writestr("Drums/kick.wav", _wav_bytes())
        z.writestr("readme.txt", "hi")
        z.writestr("../../escape.wav", _wav_bytes())
    tar_path = inbox / "Pack Two.tar.gz"
    with tarfile.open(tar_path, "w:gz") as t:
        data = _wav_bytes()
        info = tarfile.TarInfo("Bass/sub.wav")
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    (inbox / "fma_full.zip").write_bytes(b"not really")
    db = _catalog(tmp_path, [])
    conn = ing.connect(db)
    stats = ing.run_unpack(conn, [str(inbox)], str(packs), dry_run=False)
    assert stats["found"] == 2 and stats["done"] == 2
    assert (packs / "Pack_One" / "Drums" / "kick.wav").is_file()
    assert not (packs / "Pack_One" / "readme.txt").exists()
    assert not (tmp_path / "escape.wav").exists()
    assert (packs / "Pack_Two" / "Bass" / "sub.wav").is_file()
    again = ing.run_unpack(conn, [str(inbox)], str(packs), dry_run=False)
    assert again["unchanged"] == 2 and again["done"] == 0
    conn.close()


def test_unpack_skips_packs_the_campaign_already_extracted(tmp_path):
    inbox, packs = tmp_path / "incoming_zips", tmp_path / "raw_packs"
    inbox.mkdir()
    with zipfile.ZipFile(inbox / "COUCH KIT VOL. 1.zip", "w") as z:
        z.writestr("loop.wav", _wav_bytes())
    existing = packs / "COUCH_KIT_VOL._1"
    existing.mkdir(parents=True)
    (existing / "loop.wav").write_bytes(_wav_bytes())
    db = _catalog(tmp_path, [])
    conn = ing.connect(db)
    ing.run_unpack(conn, [str(inbox)], str(packs), dry_run=False)
    status, error = conn.execute("SELECT status, error FROM ingest_archives").fetchone()
    assert status == "DONE" and "already unpacked" in error
    assert sorted(p.name for p in packs.iterdir()) == ["COUCH_KIT_VOL._1"]
    conn.close()


def test_relabel_phase_moves_misfiled_vocals(tmp_path):
    db = _catalog(
        tmp_path,
        [(r"D:\corpus_4s\harmonic\1_phrase_0001.wav", "1_phrase_0001.wav", "vocal", None, None, None)],
    )
    conn = ing.connect(db)
    assert ing.run_relabel(conn, dry_run=False) == {"harmonic": 1}
    assert conn.execute("SELECT stem_type FROM slice_index").fetchone()[0] == "harmonic"
    conn.close()
