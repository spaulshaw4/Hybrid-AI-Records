"""FMA metadata resolution. Does not scan D: or ingest a genre JSON."""
from __future__ import annotations

import os
import sys

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from scripts.build_genre_corpus import (  # noqa: E402
    configure_paths,
    index_fma_audio,
    load_fma_genre_names,
    load_fma_track_genres,
    resolve_fma_meta,
)


def test_nested_fma_meta_labels_a_local_tree(tmp_path):
    meta = tmp_path / "fma" / "fma_metadata" / "fma_metadata"
    meta.mkdir(parents=True)
    (meta / "genres.csv").write_text("genre_id,title\n1,Electronic\n", encoding="utf-8")
    (meta / "tracks.csv").write_text(
        ",track\ntrack_id,genres_all\ntrack_id,\n1,\"[1]\"\n",
        encoding="utf-8",
    )
    audio = tmp_path / "fma" / "fma_large" / "000"
    audio.mkdir(parents=True)
    (audio / "000001.mp3").write_bytes(b"")
    configure_paths(tmp_path)
    assert resolve_fma_meta(tmp_path) == meta
    names = load_fma_genre_names()
    assert names[1] == "Electronic"
    assert load_fma_track_genres(names)[1] == ["Electronic"]
    assert 1 in index_fma_audio()


def test_single_fma_metadata_folder_is_used_when_the_nested_one_is_missing(tmp_path):
    meta = tmp_path / "fma" / "fma_metadata"
    meta.mkdir(parents=True)
    (meta / "genres.csv").write_text("genre_id,title\n2,Jazz\n", encoding="utf-8")
    configure_paths(tmp_path)
    assert resolve_fma_meta(tmp_path) == meta
    assert load_fma_genre_names()[2] == "Jazz"
