"""Arrangement-side genre profiles (section shape, bus density, energy curve).

Why this module exists
----------------------
``scripts/build_genre_matrix.py`` compiles 590 genre profiles into
``config/dsp_matrix.json``. Those rows are **mastering** profiles only —
``eq_bands``, ``compressor``, ``saturation``/``drive``, ``mono_below_hz``,
``ceiling_dbtp``, ``target_rms_dbfs``. They carry no section list, no bus
density, and no energy curve, so they cannot drive an arrangement on their own.

Rather than regenerate that cache with invented fields, this module adds a thin
arrangement layer on top of it:

* the matrix already assigns every slug a **family** ("Rock / Metal",
  "Hip-Hop / R&B", "Electronic / Club", …). That family selects an arrangement
  archetype here.
* three mastering fields are read back out and used to nudge bus balance:
  ``sub_gain_db`` raises the bass bus target, ``drive`` raises the rhythm bus
  target slightly, and ``mono_below_hz`` biases how low the bass pick should sit.

Slugs the matrix files as "Other" (e.g. ``heavy_alternative_rock``) are
re-derived from keywords in the slug so they do not all collapse onto one
generic skeleton.
"""
from __future__ import annotations

import json
import os
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, ".."))

DSP_MATRIX_PATHS = (
    os.environ.get("HYBRID_DSP_MATRIX", "").strip(),
    r"D:\MusicDatasets\database\dsp_matrix.json",
    os.path.join(_REPO, "config", "dsp_matrix.json"),
)

BUSES = ("rhythm", "bass", "harmonic", "vocal")

# Canonical section roles. Anything a blueprint or archetype names is folded
# onto one of these before the activation table is consulted.
SECTION_ROLES = (
    "intro",
    "verse",
    "pre_chorus",
    "build",
    "chorus",
    "drop",
    "bridge",
    "breakdown",
    "solo",
    "outro",
)

_ROLE_ALIASES = {
    "intro": "intro",
    "verse": "verse",
    "verse_1": "verse",
    "verse_2": "verse",
    "head": "verse",
    "groove": "verse",
    "pre_chorus": "pre_chorus",
    "prechorus": "pre_chorus",
    "pre": "pre_chorus",
    "build": "build",
    "riser": "build",
    "swell": "build",
    "chorus": "chorus",
    "hook": "chorus",
    "theme": "chorus",
    "drop": "drop",
    "drop_chorus": "drop",
    "bridge": "bridge",
    "breakdown": "breakdown",
    "break": "breakdown",
    "solo": "solo",
    "outro": "outro",
    "ending": "outro",
}

# Base bus activation per section role, before genre bias and energy scaling.
# 0.0 means the bus is muted for that whole section.
ROLE_ACTIVATION: dict[str, dict[str, float]] = {
    "intro":      {"rhythm": 0.55, "bass": 0.00, "harmonic": 0.80, "vocal": 0.00},
    "verse":      {"rhythm": 0.80, "bass": 0.78, "harmonic": 0.62, "vocal": 0.70},
    "pre_chorus": {"rhythm": 0.85, "bass": 0.70, "harmonic": 0.75, "vocal": 0.55},
    "build":      {"rhythm": 0.88, "bass": 0.55, "harmonic": 0.85, "vocal": 0.35},
    "chorus":     {"rhythm": 1.00, "bass": 1.00, "harmonic": 0.90, "vocal": 0.95},
    "drop":       {"rhythm": 1.00, "bass": 1.00, "harmonic": 0.72, "vocal": 0.45},
    "bridge":     {"rhythm": 0.55, "bass": 0.45, "harmonic": 0.88, "vocal": 0.62},
    "breakdown":  {"rhythm": 0.30, "bass": 0.20, "harmonic": 0.85, "vocal": 0.75},
    "solo":       {"rhythm": 0.90, "bass": 0.85, "harmonic": 0.95, "vocal": 0.10},
    "outro":      {"rhythm": 0.45, "bass": 0.35, "harmonic": 0.70, "vocal": 0.00},
}

# Two-bar pre-drop gestures. Key is the flavour, value is the bus map.
PREDROP_FLAVOURS: dict[str, dict[str, float]] = {
    "vocal_only":  {"rhythm": 0.00, "bass": 0.00, "harmonic": 0.00, "vocal": 0.95},
    "drums_only":  {"rhythm": 0.95, "bass": 0.00, "harmonic": 0.00, "vocal": 0.00},
    "harmonic_only": {"rhythm": 0.00, "bass": 0.00, "harmonic": 0.90, "vocal": 0.00},
    "vocal_and_drums": {"rhythm": 0.70, "bass": 0.00, "harmonic": 0.00, "vocal": 0.90},
}

DEFAULT_FAMILY = "other"


def _archetype(*sections: tuple[str, tuple[int, ...]]) -> list[tuple[str, tuple[int, ...]]]:
    """A section template: ordered (role, allowed bar counts) pairs."""
    return list(sections)


ARRANGEMENT_FAMILIES: dict[str, dict[str, Any]] = {
    "rock_metal": {
        "label": "Rock / Metal",
        "archetypes": [
            _archetype(
                ("intro", (4,)),
                ("verse", (8,)),
                ("pre_chorus", (4,)),
                ("chorus", (8,)),
                ("verse", (8,)),
                ("bridge", (4, 8)),
                ("chorus", (8, 16)),
                ("outro", (4,)),
            ),
            _archetype(
                ("intro", (4, 8)),
                ("verse", (8, 16)),
                ("chorus", (8,)),
                ("breakdown", (4, 8)),
                ("solo", (8,)),
                ("chorus", (8, 16)),
                ("outro", (4,)),
            ),
        ],
        "bus_bias": {"rhythm": 1.05, "bass": 1.00, "harmonic": 1.05, "vocal": 0.95},
        "bus_target_rms_dbfs": {"rhythm": -13.5, "bass": -15.5, "harmonic": -17.0, "vocal": -15.0},
        "variant_pool": {"rhythm": 2, "bass": 2, "harmonic": 3, "vocal": 3},
        "fill_probability": 0.65,
        "predrop_probability": 0.45,
        "predrop_flavours": ("drums_only", "vocal_and_drums", "vocal_only"),
        "intro_bass_out_probability": 0.80,
        "energy_gamma": 0.85,
        "bass_centroid_hz": 260.0,
        "vocal_centroid_hz": 2600.0,
    },
    "hiphop_rnb": {
        "label": "Hip-Hop / R&B",
        "archetypes": [
            _archetype(
                ("intro", (4,)),
                ("verse", (16,)),
                ("chorus", (8,)),
                ("verse", (16,)),
                ("chorus", (8,)),
                ("outro", (4,)),
            ),
            _archetype(
                ("intro", (4, 8)),
                ("chorus", (8,)),
                ("verse", (16,)),
                ("chorus", (8,)),
                ("bridge", (8,)),
                ("chorus", (8, 16)),
                ("outro", (4,)),
            ),
        ],
        "bus_bias": {"rhythm": 1.00, "bass": 1.12, "harmonic": 0.88, "vocal": 1.10},
        "bus_target_rms_dbfs": {"rhythm": -13.5, "bass": -13.0, "harmonic": -19.0, "vocal": -14.0},
        "variant_pool": {"rhythm": 2, "bass": 2, "harmonic": 2, "vocal": 4},
        "fill_probability": 0.50,
        "predrop_probability": 0.55,
        "predrop_flavours": ("vocal_only", "drums_only", "vocal_and_drums"),
        "intro_bass_out_probability": 0.50,
        "energy_gamma": 0.90,
        "bass_centroid_hz": 180.0,
        "vocal_centroid_hz": 2400.0,
    },
    "electronic_club": {
        "label": "Electronic / Club",
        "archetypes": [
            _archetype(
                ("intro", (8,)),
                ("build", (8,)),
                ("drop", (16,)),
                ("breakdown", (8,)),
                ("build", (4, 8)),
                ("drop", (16,)),
                ("outro", (8,)),
            ),
            _archetype(
                ("intro", (8, 16)),
                ("verse", (8,)),
                ("build", (8,)),
                ("drop", (16,)),
                ("breakdown", (8,)),
                ("drop", (16,)),
                ("outro", (8,)),
            ),
        ],
        "bus_bias": {"rhythm": 1.08, "bass": 1.08, "harmonic": 0.95, "vocal": 0.85},
        "bus_target_rms_dbfs": {"rhythm": -13.0, "bass": -14.0, "harmonic": -17.5, "vocal": -17.0},
        "variant_pool": {"rhythm": 2, "bass": 2, "harmonic": 3, "vocal": 2},
        "fill_probability": 0.70,
        "predrop_probability": 0.85,
        "predrop_flavours": ("harmonic_only", "vocal_only", "drums_only"),
        "intro_bass_out_probability": 0.85,
        "energy_gamma": 0.75,
        "bass_centroid_hz": 150.0,
        "vocal_centroid_hz": 2800.0,
    },
    "pop_dance": {
        "label": "Pop / Dance",
        "archetypes": [
            _archetype(
                ("intro", (4,)),
                ("verse", (8,)),
                ("pre_chorus", (4,)),
                ("chorus", (8,)),
                ("verse", (8,)),
                ("pre_chorus", (4,)),
                ("chorus", (8, 16)),
                ("outro", (4,)),
            ),
        ],
        "bus_bias": {"rhythm": 0.98, "bass": 0.95, "harmonic": 1.00, "vocal": 1.15},
        "bus_target_rms_dbfs": {"rhythm": -14.0, "bass": -16.0, "harmonic": -17.5, "vocal": -13.5},
        "variant_pool": {"rhythm": 2, "bass": 2, "harmonic": 3, "vocal": 3},
        "fill_probability": 0.55,
        "predrop_probability": 0.50,
        "predrop_flavours": ("vocal_only", "vocal_and_drums"),
        "intro_bass_out_probability": 0.65,
        "energy_gamma": 0.90,
        "bass_centroid_hz": 220.0,
        "vocal_centroid_hz": 2700.0,
    },
    "jazz_roots": {
        "label": "Jazz / Roots",
        "archetypes": [
            _archetype(
                ("intro", (4,)),
                ("verse", (16,)),
                ("solo", (16,)),
                ("verse", (16,)),
                ("outro", (4, 8)),
            ),
        ],
        "bus_bias": {"rhythm": 0.85, "bass": 0.92, "harmonic": 1.10, "vocal": 1.00},
        "bus_target_rms_dbfs": {"rhythm": -16.0, "bass": -17.0, "harmonic": -16.0, "vocal": -15.0},
        "variant_pool": {"rhythm": 3, "bass": 2, "harmonic": 3, "vocal": 2},
        "fill_probability": 0.80,
        "predrop_probability": 0.15,
        "predrop_flavours": ("harmonic_only",),
        "intro_bass_out_probability": 0.35,
        "energy_gamma": 1.05,
        "bass_centroid_hz": 300.0,
        "vocal_centroid_hz": 2500.0,
    },
    "world_latin": {
        "label": "World / Latin",
        "archetypes": [
            _archetype(
                ("intro", (4,)),
                ("verse", (16,)),
                ("breakdown", (8,)),
                ("chorus", (16,)),
                ("verse", (8,)),
                ("outro", (4, 8)),
            ),
        ],
        "bus_bias": {"rhythm": 1.10, "bass": 1.00, "harmonic": 1.00, "vocal": 1.00},
        "bus_target_rms_dbfs": {"rhythm": -13.5, "bass": -15.0, "harmonic": -17.0, "vocal": -15.5},
        "variant_pool": {"rhythm": 3, "bass": 2, "harmonic": 3, "vocal": 2},
        "fill_probability": 0.75,
        "predrop_probability": 0.35,
        "predrop_flavours": ("drums_only", "harmonic_only"),
        "intro_bass_out_probability": 0.50,
        "energy_gamma": 0.95,
        "bass_centroid_hz": 240.0,
        "vocal_centroid_hz": 2600.0,
    },
    "cinematic_ambient": {
        "label": "Cinematic / Ambient",
        "archetypes": [
            _archetype(
                ("intro", (8, 16)),
                ("build", (8,)),
                ("chorus", (16,)),
                ("breakdown", (8,)),
                ("chorus", (16,)),
                ("outro", (8, 16)),
            ),
        ],
        "bus_bias": {"rhythm": 0.45, "bass": 0.70, "harmonic": 1.20, "vocal": 0.90},
        "bus_target_rms_dbfs": {"rhythm": -19.0, "bass": -18.0, "harmonic": -14.5, "vocal": -17.0},
        "variant_pool": {"rhythm": 1, "bass": 2, "harmonic": 4, "vocal": 2},
        "fill_probability": 0.15,
        "predrop_probability": 0.25,
        "predrop_flavours": ("harmonic_only", "vocal_only"),
        "intro_bass_out_probability": 0.60,
        "energy_gamma": 1.15,
        "bass_centroid_hz": 200.0,
        "vocal_centroid_hz": 2300.0,
    },
    "other": {
        "label": "Other",
        "archetypes": [
            _archetype(
                ("intro", (4,)),
                ("verse", (8,)),
                ("build", (4,)),
                ("chorus", (8,)),
                ("verse", (8,)),
                ("chorus", (8, 16)),
                ("outro", (4,)),
            ),
        ],
        "bus_bias": {"rhythm": 1.00, "bass": 1.00, "harmonic": 1.00, "vocal": 1.00},
        "bus_target_rms_dbfs": {"rhythm": -14.0, "bass": -15.5, "harmonic": -17.5, "vocal": -15.5},
        "variant_pool": {"rhythm": 2, "bass": 2, "harmonic": 3, "vocal": 3},
        "fill_probability": 0.55,
        "predrop_probability": 0.45,
        "predrop_flavours": ("drums_only", "vocal_only"),
        "intro_bass_out_probability": 0.60,
        "energy_gamma": 0.90,
        "bass_centroid_hz": 240.0,
        "vocal_centroid_hz": 2600.0,
    },
}

# dsp_matrix.json "family" string -> arrangement family slug.
MATRIX_FAMILY_TO_ARRANGEMENT = {
    "Rock / Metal": "rock_metal",
    "Hip-Hop / R&B": "hiphop_rnb",
    "Electronic / Club": "electronic_club",
    "Pop / Dance": "pop_dance",
    "Jazz / Roots": "jazz_roots",
    "World / Latin": "world_latin",
    "Cinematic / Ambient": "cinematic_ambient",
    "Other": DEFAULT_FAMILY,
}

# Keyword rescue for slugs the mastering matrix files as "Other".
# Checked in order; first hit wins.
_SLUG_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("hiphop_rnb", ("rap", "hip_hop", "hiphop", "trap", "drill", "boom_bap", "rnb", "r_n_b", "soul", "phonk")),
    ("rock_metal", ("rock", "metal", "punk", "grunge", "hardcore", "djent", "emo", "shoegaze")),
    ("electronic_club", ("techno", "house", "edm", "dubstep", "dnb", "drum_and_bass", "trance", "electro", "garage", "breakbeat", "jungle", "club")),
    ("cinematic_ambient", ("ambient", "cinematic", "drone", "score", "orchestral", "classical", "new_age")),
    ("jazz_roots", ("jazz", "blues", "folk", "country", "bluegrass", "acoustic", "swing")),
    ("world_latin", ("latin", "afro", "reggae", "dancehall", "salsa", "cumbia", "amapiano", "world", "ska")),
    ("pop_dance", ("pop", "disco", "funk", "synthwave")),
)

_MATRIX_CACHE: dict[str, Any] | None = None


def load_dsp_matrix(path: str | None = None) -> dict[str, Any]:
    """Load the compiled genre matrix. Returns ``{}`` when no cache is present."""
    global _MATRIX_CACHE
    if path is None and _MATRIX_CACHE is not None:
        return _MATRIX_CACHE
    candidates = [path] if path else list(DSP_MATRIX_PATHS)
    for candidate in candidates:
        if not candidate or not os.path.isfile(candidate):
            continue
        try:
            with open(candidate, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and isinstance(payload.get("profiles"), dict):
            if path is None:
                _MATRIX_CACHE = payload
            return payload
    if path is None:
        _MATRIX_CACHE = {}
    return {}


def slugify_genre(genre: str | None) -> str:
    token = str(genre or "").strip().lower()
    out = []
    for ch in token:
        out.append(ch if ch.isalnum() else "_")
    slug = "".join(out)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_")


def _keyword_family(slug: str) -> str | None:
    padded = f"_{slug}_"
    for family, needles in _SLUG_KEYWORDS:
        for needle in needles:
            if needle in padded or needle in slug:
                return family
    return None


def family_for_genre(genre: str | None, matrix: dict[str, Any] | None = None) -> str:
    """Resolve a genre slug to an arrangement family.

    Keyword derivation runs first because the mastering matrix files a large
    number of real genres (``heavy_alternative_rock``, ``rap_rock``, …) under
    the catch-all "Other" family, which would otherwise collapse them all onto
    one skeleton. A non-"Other" matrix family is used when keywords miss.
    """
    slug = slugify_genre(genre)
    if not slug:
        return DEFAULT_FAMILY
    keyword = _keyword_family(slug)
    if keyword:
        return keyword
    profiles = (matrix if matrix is not None else load_dsp_matrix()).get("profiles") or {}
    row = profiles.get(slug)
    if isinstance(row, dict):
        mapped = MATRIX_FAMILY_TO_ARRANGEMENT.get(str(row.get("family") or ""))
        if mapped:
            return mapped
    return DEFAULT_FAMILY


def normalise_section_role(name: str | None) -> str:
    """Fold a free-form section name onto one of ``SECTION_ROLES``."""
    slug = slugify_genre(name)
    if not slug:
        return "verse"
    if slug in _ROLE_ALIASES:
        return _ROLE_ALIASES[slug]
    best: str | None = None
    best_len = -1
    for key, role in _ROLE_ALIASES.items():
        if slug.startswith(key) and len(key) > best_len:
            best = role
            best_len = len(key)
    return best or "verse"


def arrangement_profile(genre: str | None, matrix: dict[str, Any] | None = None) -> dict[str, Any]:
    """Arrangement profile for a genre, with mastering-matrix nudges folded in.

    The returned dict is a copy: callers may mutate it freely.
    """
    payload = matrix if matrix is not None else load_dsp_matrix()
    slug = slugify_genre(genre)
    family = family_for_genre(slug, payload)
    base = ARRANGEMENT_FAMILIES.get(family) or ARRANGEMENT_FAMILIES[DEFAULT_FAMILY]

    profile: dict[str, Any] = {
        "genre": slug or "unknown",
        "family": family,
        "label": base["label"],
        "archetypes": [list(arc) for arc in base["archetypes"]],
        "bus_bias": dict(base["bus_bias"]),
        "bus_target_rms_dbfs": dict(base["bus_target_rms_dbfs"]),
        "variant_pool": dict(base["variant_pool"]),
        "fill_probability": float(base["fill_probability"]),
        "predrop_probability": float(base["predrop_probability"]),
        "predrop_flavours": tuple(base["predrop_flavours"]),
        "intro_bass_out_probability": float(base["intro_bass_out_probability"]),
        "energy_gamma": float(base["energy_gamma"]),
        "bass_centroid_hz": float(base["bass_centroid_hz"]),
        "vocal_centroid_hz": float(base["vocal_centroid_hz"]),
        "mastering_source": None,
    }

    row = ((payload.get("profiles") or {}).get(slug)) if isinstance(payload, dict) else None
    if isinstance(row, dict):
        profile["mastering_source"] = str(row.get("source") or "unknown")
        profile["matrix_family"] = str(row.get("family") or "")
        # Genre matrix sub-shelf gain feeds the bass bus target directly: a
        # +3.2 dB hip-hop sub shelf should also mean a louder bass bus, not
        # just a louder low shelf at mastering.
        sub_gain = float(row.get("sub_gain_db") or 0.0)
        profile["bus_target_rms_dbfs"]["bass"] += 0.5 * sub_gain
        # Saturation drive tracks how aggressive the genre is; nudge drums.
        drive = float(row.get("drive") or 1.0)
        profile["bus_target_rms_dbfs"]["rhythm"] += 4.0 * (drive - 1.0)
        # A high mono-fold frequency means the genre wants weight low down.
        mono_hz = float(row.get("mono_below_hz") or 0.0)
        if mono_hz > 0:
            profile["bass_centroid_hz"] = min(profile["bass_centroid_hz"], max(90.0, mono_hz * 1.8))
    return profile


def role_activation(role: str) -> dict[str, float]:
    return dict(ROLE_ACTIVATION.get(role) or ROLE_ACTIVATION["verse"])


def known_families() -> list[str]:
    return sorted(ARRANGEMENT_FAMILIES)
