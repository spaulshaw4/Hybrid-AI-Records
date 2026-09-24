"""Genre → default key/mode when the user does not specify a key.

Prevents every render falling back to E minor (moody) for upbeat pop etc.
Pools are sampled deterministically from ``seed`` so the same prompt/genre
always lands on the same default.
"""
from __future__ import annotations

import hashlib
import re
from typing import Sequence

# Bright / major-feel genres.
_MAJOR_POOL: tuple[str, ...] = ("C_major", "G_major", "A_major")
# Rock / blues pocket (major or relative-minor colour).
_ROCK_POOL: tuple[str, ...] = ("E_major", "A_minor")
# Dark / minor-feel genres.
_MINOR_POOL: tuple[str, ...] = ("E_minor", "D_minor", "F#_minor")

# Longest-first keyword → pool. Checked against slugified genre + prompt.
_KEYWORD_POOLS: tuple[tuple[str, tuple[str, ...]], ...] = tuple(
    sorted(
        (
            ("outlaw country", _ROCK_POOL),
            ("industrial soul", _MINOR_POOL),
            ("hip hop", _MINOR_POOL),
            ("hiphop", _MINOR_POOL),
            ("trap", _MINOR_POOL),
            ("rap", _MINOR_POOL),
            ("metal", _MINOR_POOL),
            ("industrial", _MINOR_POOL),
            ("techno", _MINOR_POOL),
            ("dubstep", _MINOR_POOL),
            ("rock", _ROCK_POOL),
            ("punk", _ROCK_POOL),
            ("blues", _ROCK_POOL),
            ("outlaw", _ROCK_POOL),
            ("country", _MAJOR_POOL),
            ("pop", _MAJOR_POOL),
            ("reggae", _MAJOR_POOL),
            ("funk", _MAJOR_POOL),
            ("disco", _MAJOR_POOL),
            ("dance", _MAJOR_POOL),
            ("house", _MAJOR_POOL),
            ("soul", _MAJOR_POOL),
            ("rnb", _MAJOR_POOL),
            ("r&b", _MAJOR_POOL),
            ("folk", _MAJOR_POOL),
            ("indie", _ROCK_POOL),
            ("ambient", _MINOR_POOL),
            ("cinematic", _MINOR_POOL),
        ),
        key=lambda item: len(item[0]),
        reverse=True,
    )
)

# Arrangement-family fallbacks (from genre_feature_vector families).
_FAMILY_POOLS: dict[str, tuple[str, ...]] = {
    "pop_dance": _MAJOR_POOL,
    "world_latin": _MAJOR_POOL,
    "jazz_roots": _MAJOR_POOL,
    "rock_metal": _ROCK_POOL,
    "hiphop_rnb": _MINOR_POOL,
    "electronic_club": _MINOR_POOL,
    "cinematic_ambient": _MINOR_POOL,
    "other": _MAJOR_POOL,
    "conductor_default": _MAJOR_POOL,
}

DEFAULT_KEY_SPEC = "C_major"


def _slug(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def _pick(pool: Sequence[str], seed: int) -> str:
    if not pool:
        return DEFAULT_KEY_SPEC
    idx = abs(int(seed)) % len(pool)
    return pool[idx]


def _seed_from(prompt: str | None, genre: str | None, seed: int | None) -> int:
    if seed is not None:
        return int(seed)
    digest = hashlib.sha1(f"{genre or ''}|{prompt or ''}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def resolve_genre_default_key(
    genre: str | None = None,
    prompt: str | None = None,
    *,
    seed: int | None = None,
    family: str | None = None,
) -> str:
    """Return a combined key spec (e.g. ``G_major``) for the genre/prompt.

    Explicit user keys must be applied by the caller; this only covers the
    no-key default path.
    """
    rng = _seed_from(prompt, genre, seed)
    haystack = f"{_slug(genre)} {_slug(prompt)}"
    for keyword, pool in _KEYWORD_POOLS:
        if keyword in haystack:
            return _pick(pool, rng)

    if family and family in _FAMILY_POOLS:
        return _pick(_FAMILY_POOLS[family], rng)

    # Family inference from slug when caller did not pass one.
    try:
        from engine.genre_arrangement_profiles import family_for_genre

        inferred = family_for_genre(genre or prompt or "")
        if inferred in _FAMILY_POOLS:
            return _pick(_FAMILY_POOLS[inferred], rng)
    except Exception:
        pass

    return _pick(_MAJOR_POOL, rng)
