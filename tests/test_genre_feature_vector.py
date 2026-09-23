"""Genre feature vector blending for hybrid prompts."""
from __future__ import annotations

import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.genre_feature_vector import (  # noqa: E402
    VECTOR_AXES,
    blend_vectors,
    clamp01,
    parse_hybrid_genre_weights,
    resolve_genre_vector,
    vector_for_family,
    vector_for_genre,
)


def test_clamp01_bounds():
    assert clamp01(-1.0) == 0.0
    assert clamp01(2.0) == 1.0
    assert clamp01(0.4) == pytest.approx(0.4)


def test_family_vector_has_all_axes():
    vec = vector_for_family("rock_metal")
    assert set(vec) == set(VECTOR_AXES)
    assert vec["spectral_aggression"] > vector_for_family("cinematic_ambient")["spectral_aggression"]


def test_blend_vectors_weighted_average():
    a = {axis: 0.0 for axis in VECTOR_AXES}
    b = {axis: 1.0 for axis in VECTOR_AXES}
    out = blend_vectors([(a, 0.5), (b, 0.5)])
    for axis in VECTOR_AXES:
        assert out[axis] == pytest.approx(0.5)


def test_hybrid_prompt_parses_country_rock_synthwave():
    weights = parse_hybrid_genre_weights(
        "Cinematic Outlaw Country with Heavy Alternative Rock & Synthwave elements"
    )
    families = {w.family for w in weights}
    assert "jazz_roots" in families or "cinematic_ambient" in families
    assert "rock_metal" in families
    assert "pop_dance" in families  # synthwave


def test_explicit_fraction_weights():
    weights = parse_hybrid_genre_weights("0.50 Country + 0.35 Rock + 0.15 Synthwave")
    by_fam = {w.family: w.weight for w in weights}
    assert by_fam.get("jazz_roots", 0) == pytest.approx(0.5)
    assert by_fam.get("rock_metal", 0) == pytest.approx(0.35)
    assert by_fam.get("pop_dance", 0) == pytest.approx(0.15)


def test_resolve_genre_vector_returns_sources():
    vec, sources = resolve_genre_vector("techno drop", "techno")
    assert set(vec) == set(VECTOR_AXES)
    assert sources
    assert abs(sum(s["weight"] for s in sources) - 1.0) < 1e-6


def test_vector_for_genre_uses_family_map():
    rock = vector_for_genre("heavy_alternative_rock")
    ambient = vector_for_genre("ambient")
    assert rock["spectral_aggression"] >= ambient["spectral_aggression"]
