"""Replica staleness detection: the gate must track the source, not the replica.

``ensure_role_indexes`` writes to the replica on every refresh call, so the
replica's mtime says when the last render happened, not when the corpus last
changed. These tests pin the behaviour that depends on that distinction.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import time

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine import live_index  # noqa: E402


def _make_index(path: str, rows: int = 8) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS slice_index ("
        "id INTEGER PRIMARY KEY, file_path TEXT, filename TEXT, stem_type TEXT, "
        "stem_type_ml TEXT, detected_key TEXT, estimated_bpm REAL, rms_db REAL)"
    )
    conn.executemany(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, "
        "estimated_bpm, rms_db) VALUES (?, ?, ?, ?, ?, ?)",
        [(f"D:\\x\\{i}.wav", f"{i}.wav", "harmonic", "A", 120.0, -18.0) for i in range(rows)],
    )
    conn.commit()
    conn.close()


@pytest.fixture()
def replica(tmp_path, monkeypatch):
    src = tmp_path / "corpus_index.sqlite"
    dest = tmp_path / "corpus_index_live.sqlite"
    _make_index(str(src), rows=8)
    monkeypatch.setattr(live_index, "SOURCE_INDEX", str(src))
    monkeypatch.setattr(live_index, "FALLBACK_SOURCE", str(src))
    monkeypatch.setenv("CORPUS_INDEX_LIVE", str(dest))
    monkeypatch.delenv("CORPUS_INDEX_DB", raising=False)
    return src, dest


def test_first_refresh_copies_and_stamps_the_source(replica):
    src, dest = replica
    out = live_index.refresh_live_index_replica()
    assert out == str(dest)
    assert os.path.isfile(dest)
    stamp = live_index.source_stamp_path(str(dest))
    assert os.path.isfile(stamp), "the robust path must leave a provenance stamp"
    with open(stamp, encoding="utf-8") as handle:
        assert handle.read().strip() == live_index._source_fingerprint(str(src))


def test_recent_replica_activity_does_not_mask_a_changed_source(replica):
    src, dest = replica
    live_index.refresh_live_index_replica()
    assert live_index.source_changed(str(src), str(dest)) is False

    # The corpus grows on D:, and a render touches the replica immediately
    # after (which is what ensure_role_indexes does on every call). An
    # age-of-replica check would short-circuit here and never see the change.
    conn = sqlite3.connect(src)
    conn.execute(
        "INSERT INTO slice_index (file_path, filename, stem_type) VALUES ('D:\\n.wav','n.wav','rhythm')"
    )
    conn.commit()
    conn.close()
    os.utime(dest, None)
    assert os.path.getmtime(dest) >= os.path.getmtime(src)

    assert live_index.source_changed(str(src), str(dest)) is True
    live_index.refresh_live_index_replica()
    rows = sqlite3.connect(f"file:{str(dest).replace(os.sep, '/')}?mode=ro", uri=True)
    try:
        assert rows.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0] == 9
    finally:
        rows.close()


def test_unchanged_source_is_not_recopied(replica, monkeypatch):
    src, dest = replica
    live_index.refresh_live_index_replica()

    def _fail(*_args, **_kwargs):
        raise AssertionError("an unchanged source must not be copied again")

    monkeypatch.setattr(live_index, "_backup_with_deadline", _fail)
    assert live_index.refresh_live_index_replica() == str(dest)


def test_stampless_replica_of_matching_size_is_adopted(replica):
    src, dest = replica
    # The replica that exists today: a byte copy of the source made before
    # provenance was tracked. It must be adopted and stamped, not re-copied
    # inside the next render.
    shutil.copyfile(src, dest)
    assert not os.path.isfile(live_index.source_stamp_path(str(dest)))
    assert live_index.source_changed(str(src), str(dest)) is False

    live_index.refresh_live_index_replica()
    stamp = live_index.source_stamp_path(str(dest))
    assert os.path.isfile(stamp)
    with open(stamp, encoding="utf-8") as handle:
        assert handle.read().strip() == live_index._source_fingerprint(str(src))


def test_failed_copy_backs_off_instead_of_retrying_every_render(replica, monkeypatch):
    src, dest = replica
    live_index.refresh_live_index_replica()
    conn = sqlite3.connect(src)
    conn.execute(
        "INSERT INTO slice_index (file_path, filename, stem_type) VALUES ('D:\\n.wav','n.wav','rhythm')"
    )
    conn.commit()
    conn.close()

    attempts = []

    def _stall(*_args, **_kwargs):
        attempts.append(time.time())
        raise TimeoutError("sqlite backup exceeded 90s")

    monkeypatch.setattr(live_index, "_backup_with_deadline", _stall)
    live_index.refresh_live_index_replica()
    live_index.refresh_live_index_replica()
    assert len(attempts) == 1, "a failed copy must cool off, not restart every render"
    assert live_index._copy_cooling_off(str(dest), live_index._source_fingerprint(str(src))) > 0


def test_backup_deadline_aborts_a_stalled_transfer(tmp_path):
    src = tmp_path / "big.sqlite"
    dest = tmp_path / "out.sqlite"
    _make_index(str(src), rows=20000)
    src_conn = sqlite3.connect(
        f"file:{str(src).replace(os.sep, '/')}?mode=ro", uri=True
    )
    dst_conn = sqlite3.connect(str(dest))
    try:
        with pytest.raises(TimeoutError):
            live_index._backup_with_deadline(src_conn, dst_conn, timeout_sec=-1.0)
    finally:
        dst_conn.close()
        src_conn.close()
