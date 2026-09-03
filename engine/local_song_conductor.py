"""Local algorithmic song conductor: Intro → Verse → Build → Drop.

This is the arrangement brain Stephen asked for by name. Given a prompt,
genre, tempo, and duration, it builds a chronological section map with a
per-section mute/gain vector for the four parallel buses (drums/rhythm, bass,
harmonic, vocal). The assembler then tiles **one loop per bus per section**
(8-bar lock *within* a section, 20 ms equal-power + ZC at joins) — it does
not collage packs horizontally.

Seeded RNG
----------
Every structural choice (which IVBD variant, bar counts, pre-drop, fill,
per-bus gain jitter, loop-variant index) is drawn from ``random.Random(seed)``.
The same seed reproduces the identical map; a different seed does not.

Genre / energy
--------------
If ``config/dsp_matrix.json`` (or ``D:\\MusicDatasets\\database\\dsp_matrix.json``)
loads, family energy-gamma, bus bias, and RMS targets come from
``engine.genre_arrangement_profiles``. If the matrix is absent, the documented
defaults below are used. The *skeleton* is always Intro→Verse→Build→Drop,
with a second verse and/or outro when duration allows.

Index honesty (``D:\\MusicDatasets\\db\\corpus_index.sqlite``, 52,725 rows)
-------------------------------------------------------------------------
Census 2026-08-31:

* ``stem_type`` has **no bass**: harmonic 27,944 / rhythm 13,126 /
  vocal 10,811 / lead 844 / bass 0.
* Bass files exist as *filenames* (11,572 ``bass_s4_*.wav``, all filed
  harmonic) plus a handful of ``808`` names. There are zero ``sub`` filenames.
  Selection therefore matches filename/tags (``bass``, ``808``, ``sub``) and,
  if that pool is empty, falls back to harmonic rows with a low spectral
  centroid (< 450 Hz).
* ``detected_key`` is a **pitch class only** (no maj/min). ``A`` is 17,158
  rows (32.5 %) and is the likely detection fallback — match on pitch class,
  never on mode.
"""
from __future__ import annotations

import os
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.arrangement_brain import (  # noqa: E402
    apply_arrangement_to_blueprint,
    arrangement_signature,
    build_arrangement,
    derive_seed,
    describe_arrangement,
)
from engine.genre_arrangement_profiles import (  # noqa: E402
    BUSES,
    arrangement_profile,
    load_dsp_matrix,
    slugify_genre,
)

SKELETON_NAME = "intro_verse_build_drop"
CONDUCTOR_NAME = "local_song_conductor"
BUSES = BUSES  # drums live on the rhythm bus

# Documented defaults when the genre matrix is missing. Numbers match
# ``blueprint_track_assembler.DEFAULT_BUS_TARGET_RMS`` and the "other" family.
DEFAULT_ENERGY_GAMMA = 0.90
DEFAULT_BUS_BIAS = {"rhythm": 1.00, "bass": 1.00, "harmonic": 1.00, "vocal": 1.00}
DEFAULT_BUS_TARGET_RMS = {
    "rhythm": -14.0,
    "bass": -15.5,
    "harmonic": -17.5,
    "vocal": -15.5,
}
DEFAULT_VARIANT_POOL = {"rhythm": 2, "bass": 2, "harmonic": 3, "vocal": 3}
DEFAULT_FILL_PROBABILITY = 0.55
DEFAULT_PREDROP_PROBABILITY = 0.45
DEFAULT_PREDROP_FLAVOURS = ("drums_only", "vocal_only")
DEFAULT_INTRO_BASS_OUT = 0.70
DEFAULT_BASS_CENTROID_HZ = 240.0
DEFAULT_VOCAL_CENTROID_HZ = 2600.0

# Intro → Verse → Build → Drop, then verse / outro as duration allows.
# Bar counts are 4 or 8 (drop may be 16) so an 8-bar lock fits inside a section.
CONDUCTOR_ARCHETYPES: list[list[tuple[str, tuple[int, ...]]]] = [
    [
        ("intro", (4, 8)),
        ("verse", (8,)),
        ("build", (4, 8)),
        ("drop", (8, 16)),
        ("verse", (8,)),
        ("outro", (4, 8)),
    ],
    [
        ("intro", (8,)),
        ("verse", (8, 16)),
        ("build", (8,)),
        ("drop", (16,)),
        ("outro", (4, 8)),
    ],
    [
        ("intro", (4,)),
        ("verse", (8,)),
        ("build", (4,)),
        ("drop", (8,)),
        ("verse", (8,)),
        ("build", (4,)),
        ("drop", (8,)),
        ("outro", (4,)),
    ],
]

INDEX_HONESTY = (
    "stem_type has no bass (harmonic 27944, rhythm 13126, vocal 10811, lead 844). "
    "Bass from filename/tags (bass_s4, 808, sub) or harmonic low-centroid fallback. "
    "Keys are pitch class only; A is 32.5% (likely fallback) -- match pitch class, not maj/min."
)

REQUIRED_ROLES = ("intro", "verse", "build", "drop")


def _documented_default_profile(genre: str | None) -> dict[str, Any]:
    slug = slugify_genre(genre)
    return {
        "genre": slug or "unknown",
        "family": "conductor_default",
        "label": "Conductor default (Intro→Verse→Build→Drop)",
        "archetypes": [list(arc) for arc in CONDUCTOR_ARCHETYPES],
        "bus_bias": dict(DEFAULT_BUS_BIAS),
        "bus_target_rms_dbfs": dict(DEFAULT_BUS_TARGET_RMS),
        "variant_pool": dict(DEFAULT_VARIANT_POOL),
        "fill_probability": float(DEFAULT_FILL_PROBABILITY),
        "predrop_probability": float(DEFAULT_PREDROP_PROBABILITY),
        "predrop_flavours": tuple(DEFAULT_PREDROP_FLAVOURS),
        "intro_bass_out_probability": float(DEFAULT_INTRO_BASS_OUT),
        "energy_gamma": float(DEFAULT_ENERGY_GAMMA),
        "bass_centroid_hz": float(DEFAULT_BASS_CENTROID_HZ),
        "vocal_centroid_hz": float(DEFAULT_VOCAL_CENTROID_HZ),
        "mastering_source": "documented_defaults",
    }


def conduct_profile(genre: str | None) -> dict[str, Any]:
    """Energy curve + bus bias from the genre matrix, IVBD skeleton always.

    The compiled matrix is mastering-only (EQ / compressor / drive). When it
    loads, family energy-gamma and bus RMS targets are reused. When it does
    not, the documented defaults in this module are used. Either way the
    section list is Intro→Verse→Build→Drop (plus verse/outro as needed).
    """
    matrix = load_dsp_matrix()
    if matrix.get("profiles"):
        profile = arrangement_profile(genre, matrix)
        profile["archetypes"] = [list(arc) for arc in CONDUCTOR_ARCHETYPES]
        return profile
    return _documented_default_profile(genre)


def conduct_arrangement(
    prompt: str,
    genre: str | None,
    bpm: float,
    duration_sec: float | None = None,
    *,
    seed: int | None = None,
    request_id: str | None = None,
    explicit_seed: int | None = None,
) -> dict[str, Any]:
    """Build a seeded Intro→Verse→Build→Drop map with per-section bus gains."""
    profile = conduct_profile(genre)
    arrangement = build_arrangement(
        prompt,
        genre,
        bpm,
        duration_sec,
        seed=seed,
        request_id=request_id,
        explicit_seed=explicit_seed,
        profile=profile,
    )
    arrangement["conductor"] = CONDUCTOR_NAME
    arrangement["skeleton"] = SKELETON_NAME
    arrangement["index_honesty"] = INDEX_HONESTY
    return arrangement


def describe_conducted(arrangement: dict[str, Any]) -> str:
    """Section map plus the index-honesty line, for the CLI / render report."""
    header = (
        f"conductor={arrangement.get('conductor', CONDUCTOR_NAME)} "
        f"skeleton={arrangement.get('skeleton', SKELETON_NAME)}"
    )
    return (
        header
        + "\n"
        + describe_arrangement(arrangement)
        + "\n[INDEX] "
        + str(arrangement.get("index_honesty") or INDEX_HONESTY)
    )


# Public aliases so generate_track_headless can import from one module.
apply_conducted_blueprint = apply_arrangement_to_blueprint
conduct_signature = arrangement_signature


if __name__ == "__main__":  # pragma: no cover - manual inspection helper
    import argparse

    parser = argparse.ArgumentParser(description="Print a seeded conductor map")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--genre", default=None)
    parser.add_argument("--bpm", type=float, default=120.0)
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--request-id", default=None)
    args = parser.parse_args()
    plan = conduct_arrangement(
        args.prompt,
        args.genre,
        args.bpm,
        args.duration,
        request_id=args.request_id,
        explicit_seed=args.seed,
    )
    print(describe_conducted(plan))
