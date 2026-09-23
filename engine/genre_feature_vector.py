"""Multi-dimensional genre trait vectors for hybrid prompt blending.

Maps arrangement families (and optional slug overrides) onto the five axes
used by ``engine.song_plan.GenreVector``. Hybrid prompts like
\"Cinematic Outlaw Country with Heavy Alternative Rock & Synthwave\" are
parsed into weighted tokens and averaged into one vector.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

from engine.genre_arrangement_profiles import (
    ARRANGEMENT_FAMILIES,
    DEFAULT_FAMILY,
    family_for_genre,
    slugify_genre,
)

VECTOR_AXES = (
    "harmonic_complexity",
    "rhythmic_syncopation",
    "spectral_aggression",
    "dynamic_headroom",
    "spatial_depth",
)

# Family defaults: low = sparse/clean/intimate, high = dense/aggressive/wide.
FAMILY_VECTORS: dict[str, dict[str, float]] = {
    "rock_metal": {
        "harmonic_complexity": 0.35,
        "rhythmic_syncopation": 0.40,
        "spectral_aggression": 0.85,
        "dynamic_headroom": 0.55,
        "spatial_depth": 0.45,
    },
    "hiphop_rnb": {
        "harmonic_complexity": 0.40,
        "rhythmic_syncopation": 0.70,
        "spectral_aggression": 0.55,
        "dynamic_headroom": 0.30,
        "spatial_depth": 0.40,
    },
    "electronic_club": {
        "harmonic_complexity": 0.45,
        "rhythmic_syncopation": 0.55,
        "spectral_aggression": 0.70,
        "dynamic_headroom": 0.20,
        "spatial_depth": 0.65,
    },
    "pop_dance": {
        "harmonic_complexity": 0.40,
        "rhythmic_syncopation": 0.35,
        "spectral_aggression": 0.45,
        "dynamic_headroom": 0.35,
        "spatial_depth": 0.50,
    },
    "jazz_roots": {
        "harmonic_complexity": 0.85,
        "rhythmic_syncopation": 0.75,
        "spectral_aggression": 0.25,
        "dynamic_headroom": 0.70,
        "spatial_depth": 0.45,
    },
    "world_latin": {
        "harmonic_complexity": 0.55,
        "rhythmic_syncopation": 0.80,
        "spectral_aggression": 0.35,
        "dynamic_headroom": 0.55,
        "spatial_depth": 0.50,
    },
    "cinematic_ambient": {
        "harmonic_complexity": 0.60,
        "rhythmic_syncopation": 0.25,
        "spectral_aggression": 0.20,
        "dynamic_headroom": 0.85,
        "spatial_depth": 0.90,
    },
    "other": {
        "harmonic_complexity": 0.50,
        "rhythmic_syncopation": 0.50,
        "spectral_aggression": 0.50,
        "dynamic_headroom": 0.50,
        "spatial_depth": 0.50,
    },
    "conductor_default": {
        "harmonic_complexity": 0.50,
        "rhythmic_syncopation": 0.50,
        "spectral_aggression": 0.50,
        "dynamic_headroom": 0.50,
        "spatial_depth": 0.50,
    },
}

# Keyword -> family for hybrid prompt parsing (checked longest-first).
_PROMPT_FAMILY_HINTS: tuple[tuple[str, str], ...] = tuple(
    sorted(
        (
            ("synthwave", "pop_dance"),
            ("outlaw country", "jazz_roots"),
            ("alternative rock", "rock_metal"),
            ("heavy metal", "rock_metal"),
            ("cinematic", "cinematic_ambient"),
            ("ambient", "cinematic_ambient"),
            ("country", "jazz_roots"),
            ("bluegrass", "jazz_roots"),
            ("jazz", "jazz_roots"),
            ("blues", "jazz_roots"),
            ("folk", "jazz_roots"),
            ("rock", "rock_metal"),
            ("metal", "rock_metal"),
            ("punk", "rock_metal"),
            ("techno", "electronic_club"),
            ("house", "electronic_club"),
            ("edm", "electronic_club"),
            ("trance", "electronic_club"),
            ("dubstep", "electronic_club"),
            ("hip hop", "hiphop_rnb"),
            ("hip-hop", "hiphop_rnb"),
            ("trap", "hiphop_rnb"),
            ("r&b", "hiphop_rnb"),
            ("soul", "hiphop_rnb"),
            ("rap", "hiphop_rnb"),
            ("latin", "world_latin"),
            ("reggae", "world_latin"),
            ("pop", "pop_dance"),
            ("disco", "pop_dance"),
            ("funk", "pop_dance"),
        ),
        key=lambda item: len(item[0]),
        reverse=True,
    )
)

_WEIGHT_SPLIT = re.compile(
    r"\s*(?:,|/|&|\+|with|and|x|\u00d7)\s*",
    re.IGNORECASE,
)


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


@dataclass(frozen=True)
class GenreWeight:
    family: str
    weight: float
    token: str = ""


def vector_for_family(family: str | None) -> dict[str, float]:
    key = str(family or DEFAULT_FAMILY).strip() or DEFAULT_FAMILY
    base = FAMILY_VECTORS.get(key) or FAMILY_VECTORS[DEFAULT_FAMILY]
    return {axis: clamp01(base.get(axis, 0.5)) for axis in VECTOR_AXES}


def vector_for_genre(genre: str | None) -> dict[str, float]:
    family = family_for_genre(genre) if genre else DEFAULT_FAMILY
    if family not in ARRANGEMENT_FAMILIES and family not in FAMILY_VECTORS:
        family = DEFAULT_FAMILY
    return vector_for_family(family)


def blend_vectors(
    weighted: Sequence[Mapping[str, float] | tuple[Mapping[str, float], float]],
) -> dict[str, float]:
    """Weighted average of genre vectors. Empty input -> neutral 0.5s."""
    if not weighted:
        return {axis: 0.5 for axis in VECTOR_AXES}

    totals = {axis: 0.0 for axis in VECTOR_AXES}
    weight_sum = 0.0
    for item in weighted:
        if isinstance(item, tuple):
            vec, weight = item
        else:
            vec, weight = item, 1.0
        w = max(0.0, float(weight))
        if w <= 0.0:
            continue
        weight_sum += w
        for axis in VECTOR_AXES:
            totals[axis] += clamp01(float(vec.get(axis, 0.5))) * w
    if weight_sum <= 0.0:
        return {axis: 0.5 for axis in VECTOR_AXES}
    return {axis: clamp01(totals[axis] / weight_sum) for axis in VECTOR_AXES}


def _match_family_token(token: str) -> str | None:
    slug = slugify_genre(token)
    if not slug:
        return None
    # Direct family / slug hit first.
    if slug in FAMILY_VECTORS:
        return slug
    family = family_for_genre(slug)
    if family and family != DEFAULT_FAMILY:
        return family
    lowered = token.lower().strip()
    for needle, fam in _PROMPT_FAMILY_HINTS:
        if needle in lowered:
            return fam
    return family if family else None


def parse_hybrid_genre_weights(
    prompt: str | None,
    genre_hint: str | None = None,
) -> list[GenreWeight]:
    """Extract weighted genre families from a hybrid prompt + optional hint.

    Explicit fractions like ``0.5 Country`` are honoured; otherwise equal
    weights are assigned across distinct matched families. The genre hint is
    always included (weight 1.0 before renormalisation) when present.
    """
    found: list[GenreWeight] = []
    seen: set[str] = set()

    def _add(family: str | None, weight: float, token: str) -> None:
        if not family:
            return
        fam = family if family in FAMILY_VECTORS else family_for_genre(family)
        fam = fam if fam in FAMILY_VECTORS else DEFAULT_FAMILY
        if fam in seen and not token:
            return
        seen.add(fam)
        found.append(GenreWeight(family=fam, weight=max(0.0, float(weight)), token=token))

    hint = str(genre_hint or "").strip()
    if hint:
        _add(_match_family_token(hint) or family_for_genre(hint), 1.0, hint)

    text = str(prompt or "").strip()
    if text:
        # Prefer \"0.50 Country + 0.35 Rock\" style tokens when present.
        frac_hits = re.findall(
            r"(?P<w>\d*\.?\d+)\s*[x\u00d7*]?\s*(?P<label>[A-Za-z][A-Za-z0-9 &\-/]{1,40})",
            text,
        )
        used_frac = False
        for raw_w, label in frac_hits:
            try:
                w = float(raw_w)
            except ValueError:
                continue
            if w <= 0.0 or w > 1.5:
                continue
            fam = _match_family_token(label)
            if fam:
                used_frac = True
                _add(fam, w, label.strip())
        if not used_frac:
            chunks = [c.strip() for c in _WEIGHT_SPLIT.split(text) if c and c.strip()]
            if len(chunks) <= 1:
                chunks = [text]
            for chunk in chunks:
                fam = _match_family_token(chunk)
                if fam:
                    _add(fam, 1.0, chunk)

    if not found:
        _add(DEFAULT_FAMILY, 1.0, hint or "default")
    return found


def resolve_genre_vector(
    prompt: str | None,
    genre_hint: str | None = None,
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """Return ``(blended_vector, source_genres)`` for the song plan."""
    weights = parse_hybrid_genre_weights(prompt, genre_hint)
    total = sum(w.weight for w in weights) or 1.0
    pairs = [(vector_for_family(w.family), w.weight) for w in weights]
    blended = blend_vectors(pairs)
    sources = [
        {
            "family": w.family,
            "weight": round(w.weight / total, 4),
            "token": w.token,
            "vector": vector_for_family(w.family),
        }
        for w in weights
    ]
    return blended, sources


def arrangement_nudges_from_vector(vector: Mapping[str, float]) -> dict[str, Any]:
    """Derive soft arrangement knobs from a blended genre vector."""
    aggression = clamp01(vector.get("spectral_aggression", 0.5))
    syncopation = clamp01(vector.get("rhythmic_syncopation", 0.5))
    headroom = clamp01(vector.get("dynamic_headroom", 0.5))
    depth = clamp01(vector.get("spatial_depth", 0.5))
    complexity = clamp01(vector.get("harmonic_complexity", 0.5))
    return {
        "energy_gamma": round(0.70 + 0.50 * (1.0 - headroom), 3),
        "bus_bias": {
            "rhythm": round(0.92 + 0.20 * aggression, 3),
            "bass": round(0.95 + 0.15 * syncopation, 3),
            "harmonic": round(0.90 + 0.20 * complexity, 3),
            "vocal": round(0.95 + 0.10 * (1.0 - aggression), 3),
        },
        "fill_probability": round(0.40 + 0.40 * syncopation, 3),
        "predrop_probability": round(0.35 + 0.45 * aggression, 3),
        "spatial_reverb_send": round(0.10 + 0.20 * depth, 3),
    }
