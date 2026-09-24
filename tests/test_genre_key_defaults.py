"""Genre-aware default key / mode selection."""
from __future__ import annotations

import os
import sys

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.genre_key_defaults import (  # noqa: E402
    DEFAULT_KEY_SPEC,
    resolve_genre_default_key,
)
from engine.song_plan import build_song_plan, parse_key_scale  # noqa: E402


def test_pop_defaults_major():
    key = resolve_genre_default_key("pop", "upbeat summer pop anthem", seed=1)
    root, scale = parse_key_scale(key)
    assert scale == "major"
    assert root in {"C", "G", "A"}


def test_rock_defaults_rock_pool():
    key = resolve_genre_default_key("rock", "driving rock riff", seed=2)
    assert key in {"E_major", "A_minor"}


def test_hiphop_defaults_minor():
    key = resolve_genre_default_key("hip hop", "dark trap beat", seed=3)
    root, scale = parse_key_scale(key)
    assert scale == "minor"
    assert root in {"E", "D", "F#"}


def test_metal_defaults_minor():
    key = resolve_genre_default_key("metal", None, seed=0)
    _, scale = parse_key_scale(key)
    assert scale == "minor"


def test_same_seed_same_default():
    a = resolve_genre_default_key("country", "twangy chorus", seed=42)
    b = resolve_genre_default_key("country", "twangy chorus", seed=42)
    assert a == b


def test_build_song_plan_uses_genre_default_without_key():
    plan = build_song_plan("bright dance-floor pop chorus", "pop", seed=11, bpm=120)
    assert plan.scale == "major"
    assert plan.key in {"C", "G", "A"}
    assert DEFAULT_KEY_SPEC == "C_major"


def test_explicit_key_still_wins():
    plan = build_song_plan("pop hit", "pop", seed=11, bpm=120, key="E_minor")
    assert plan.key == "E"
    assert plan.scale == "minor"
