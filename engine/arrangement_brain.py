"""Seeded arrangement brain: prompt + genre -> a real per-section song structure.

Three problems this solves, in order:

1. **Monotony.** The 4-bus assembler locks one drum and one bass loop for the
   whole track, which fixed a horizontal-collage bug but made every 60 s render
   sound like one loop. Here the loop stays steady *within* a phrase but the
   **bus activation map** changes across sections, so intro / verse / chorus /
   drop / outro differ: bass can drop out for the intro, the full stack lands at
   the chorus, and a two-bar pre-drop can leave only a vocal or only drums.

2. **Sameness across users.** Every choice below - archetype, bar counts,
   pre-drop placement and flavour, per-section loop variant, fill placement,
   gain jitter - is drawn from a single seeded ``random.Random``. The seed is
   derived from ``prompt + request identity``, so two users asking for the same
   genre get different songs, while ``--seed`` reproduces one exactly.

3. **Genre means nothing.** The archetype list, bus bias, energy curve, and
   per-bus level targets come from ``engine.genre_arrangement_profiles``, which
   is keyed off the family the compiled 590-profile genre matrix already
   assigns. Different genres get structurally different songs, not one skeleton
   with swapped samples.

Bar math is unchanged: section lengths are whole 4/4 bars and
``samples_per_bar = int(sr * 240 / bpm)``.
"""
from __future__ import annotations

import hashlib
import os
import sys
import time
import uuid
from random import Random
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.genre_arrangement_profiles import (  # noqa: E402
    BUSES,
    PREDROP_FLAVOURS,
    arrangement_profile,
    normalise_section_role,
    role_activation,
)

SEED_BITS = 64
SEED_MASK = (1 << SEED_BITS) - 1
PREDROP_BARS = 2
MIN_SECTION_BARS = 2
# More than two stripped-back gestures in one song reads as a gimmick.
MAX_PREDROPS = 2
BEATS_PER_BAR = 4

# Roles that may be dropped when a short duration cannot fit the archetype,
# least load-bearing first.
_TRIMMABLE_ORDER = ("solo", "bridge", "breakdown", "build", "pre_chorus", "verse")

# Nominal energy per role, before the genre gamma curve and position ramp.
_ROLE_ENERGY = {
    "intro": 0.25,
    "verse": 0.55,
    "pre_chorus": 0.70,
    "build": 0.78,
    "chorus": 0.95,
    "drop": 1.00,
    "bridge": 0.50,
    "breakdown": 0.35,
    "solo": 0.85,
    "outro": 0.22,
    "pre_drop": 0.40,
}


def default_request_id() -> str:
    """A fresh request identity: uuid4 plus a nanosecond stamp.

    This is what makes two users asking for the same genre diverge. Callers
    that have a real user/session id should pass it instead.
    """
    return f"{uuid.uuid4().hex}-{time.time_ns()}"


def derive_seed(
    prompt: str,
    request_id: str | None = None,
    explicit_seed: int | None = None,
) -> tuple[int, str]:
    """Return ``(seed, request_id)``.

    ``explicit_seed`` wins outright so ``--seed`` reproduces a track exactly.
    Otherwise the seed is ``sha256(prompt || request_id)`` folded to 64 bits.
    """
    if explicit_seed is not None:
        return int(explicit_seed) & SEED_MASK, str(request_id or "explicit-seed")
    rid = str(request_id or default_request_id())
    blob = f"{prompt or ''}\x1f{rid}".encode("utf-8")
    digest = hashlib.sha256(blob).digest()
    return int.from_bytes(digest[:8], "big") & SEED_MASK, rid


def bars_to_seconds(bars: float, bpm: float) -> float:
    return float(bars) * (60.0 / max(1e-6, float(bpm))) * BEATS_PER_BAR


def seconds_to_bars(seconds: float, bpm: float) -> int:
    one = bars_to_seconds(1.0, bpm)
    if one <= 0:
        return 1
    return max(1, int(round(float(seconds) / one)))


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, float(value)))


def _quantize_bars(bars: float) -> int:
    """Whole bars, kept even above 2 so phrases stay musical."""
    n = int(round(float(bars)))
    if n <= MIN_SECTION_BARS:
        return MIN_SECTION_BARS
    if n % 2:
        n += 1
    return n


def _expand_archetype(archetype: list, rng: Random) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for role, choices in archetype:
        sections.append(
            {
                "role": role,
                "bars": int(rng.choice(list(choices))),
                "locked": False,
                "predrop": False,
            }
        )
    return sections


def _insert_predrops(
    sections: list[dict[str, Any]],
    profile: dict[str, Any],
    rng: Random,
) -> list[dict[str, Any]]:
    """Steal two bars in front of a chorus/drop for a stripped-back gesture."""
    probability = float(profile["predrop_probability"])
    flavours = list(profile["predrop_flavours"]) or ["drums_only"]
    out: list[dict[str, Any]] = []
    placed = 0
    for index, section in enumerate(sections):
        is_peak = section["role"] in {"chorus", "drop"}
        prev_ok = bool(out) and out[-1]["bars"] >= (PREDROP_BARS + MIN_SECTION_BARS)
        if placed >= MAX_PREDROPS:
            out.append(section)
            continue
        if index > 0 and is_peak and prev_ok and rng.random() < probability:
            placed += 1
            out[-1]["bars"] -= PREDROP_BARS
            out.append(
                {
                    "role": "pre_drop",
                    "bars": PREDROP_BARS,
                    "locked": True,
                    "predrop": True,
                    "flavour": rng.choice(flavours),
                }
            )
        out.append(section)
    return out


def _fit_to_bars(
    sections: list[dict[str, Any]],
    target_bars: int,
    rng: Random,
) -> list[dict[str, Any]]:
    """Scale flexible sections to ``target_bars``, trimming sections if needed."""
    working = [dict(s) for s in sections]
    target = max(MIN_SECTION_BARS, int(target_bars))

    def minimum_span(items: list[dict[str, Any]]) -> int:
        return sum(s["bars"] if s["locked"] else MIN_SECTION_BARS for s in items)

    # Too short for the archetype: drop the least load-bearing sections.
    guard = 0
    while minimum_span(working) > target and len(working) > 2 and guard < 64:
        guard += 1
        victim = None
        for role in _TRIMMABLE_ORDER:
            matches = [i for i, s in enumerate(working) if s["role"] == role and not s["locked"]]
            if len(matches) > 1:
                victim = matches[-1]
                break
            if matches and role not in {"verse"}:
                victim = matches[0]
                break
        if victim is None:
            flexible = [i for i, s in enumerate(working) if not s["locked"]]
            if len(flexible) <= 2:
                break
            victim = flexible[len(flexible) // 2]
        removed = working.pop(victim)
        # A stranded pre-drop with nothing to lead into is meaningless.
        if removed["role"] in {"chorus", "drop"}:
            working = [
                s
                for i, s in enumerate(working)
                if not (s.get("predrop") and i == victim - 1)
            ]

    locked = sum(s["bars"] for s in working if s["locked"])
    flexible_idx = [i for i, s in enumerate(working) if not s["locked"]]
    flexible_total = sum(working[i]["bars"] for i in flexible_idx)
    budget = max(MIN_SECTION_BARS * len(flexible_idx), target - locked)
    if flexible_total > 0 and flexible_idx:
        scale = budget / float(flexible_total)
        for i in flexible_idx:
            working[i]["bars"] = _quantize_bars(working[i]["bars"] * scale)

    # Whole-bar rounding drift. Spread it two bars at a time across the longest
    # flexible sections instead of dumping the whole deficit on one, which is
    # what produced 2-bar verses and 3-bar choruses.
    guard = 0
    while flexible_idx and guard < 512:
        guard += 1
        total = sum(s["bars"] for s in working)
        drift = target - total
        if drift == 0:
            break
        step = 2 if abs(drift) >= 2 else 1
        order = sorted(flexible_idx, key=lambda i: working[i]["bars"], reverse=(drift < 0))
        moved = False
        for i in order:
            if drift > 0:
                working[i]["bars"] += step
                moved = True
                break
            headroom = working[i]["bars"] - MIN_SECTION_BARS
            if headroom > 0:
                working[i]["bars"] -= min(step, headroom)
                moved = True
                break
        if not moved:
            break
    return working


def _section_energy(role: str, position: float, gamma: float) -> float:
    """Role energy, lifted slightly as the track progresses, shaped by gamma."""
    base = float(_ROLE_ENERGY.get(role, 0.55))
    ramp = 1.0 + 0.12 * (float(position) - 0.5)
    return _clamp(pow(_clamp(base * ramp), max(0.2, float(gamma))))


def _name_sections(sections: list[dict[str, Any]]) -> None:
    counts: dict[str, int] = {}
    for section in sections:
        role = section["role"]
        counts[role] = counts.get(role, 0) + 1
        section["name"] = role if counts[role] == 1 else f"{role}_{counts[role]}"


def _fill_bars_for(section: dict[str, Any], probability: float, rng: Random) -> list[int]:
    """Bar offsets (0-based, within the section) that get a drum fill variant."""
    bars = int(section["bars"])
    if section["predrop"] or bars < 4:
        return []
    fills: list[int] = []
    if rng.random() < probability:
        fills.append(bars - 1)
    if bars >= 16 and rng.random() < probability:
        fills.append(bars // 2 - 1)
    return sorted(set(f for f in fills if 0 <= f < bars))


def build_arrangement(
    prompt: str,
    genre: str | None,
    bpm: float,
    duration_sec: float | None = None,
    *,
    seed: int | None = None,
    request_id: str | None = None,
    explicit_seed: int | None = None,
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a full section map. Every choice is drawn from the seeded RNG.

    ``profile`` lets ``engine.local_song_conductor`` inject the Intro→Verse→
    Build→Drop skeleton (and documented energy defaults) without forking this
    RNG sequence. Omit it and the genre-family archetypes are used as before.
    """
    if seed is None:
        seed, request_id = derive_seed(prompt, request_id, explicit_seed)
    else:
        seed = int(seed) & SEED_MASK
        request_id = str(request_id or "explicit-seed")

    rng = Random(seed)
    profile = dict(profile) if profile is not None else arrangement_profile(genre)
    archetypes = profile["archetypes"]
    archetype_index = rng.randrange(len(archetypes))

    sections = _expand_archetype(archetypes[archetype_index], rng)
    sections = _insert_predrops(sections, profile, rng)

    if duration_sec and duration_sec > 0:
        target_bars = seconds_to_bars(float(duration_sec), bpm)
        sections = _fit_to_bars(sections, target_bars, rng)

    _name_sections(sections)

    bias = profile["bus_bias"]
    gamma = float(profile["energy_gamma"])
    pool = profile["variant_pool"]
    fill_probability = float(profile["fill_probability"])
    intro_bass_out = rng.random() < float(profile["intro_bass_out_probability"])

    total = max(1, len(sections))
    for index, section in enumerate(sections):
        role = section["role"]
        position = index / float(total - 1) if total > 1 else 0.0
        energy = _section_energy(role, position, gamma)
        section["energy"] = round(energy, 3)

        if section["predrop"]:
            base = dict(PREDROP_FLAVOURS.get(section.get("flavour") or "drums_only"))
        else:
            base = role_activation(role)

        activation: dict[str, float] = {}
        for bus in BUSES:
            level = float(base.get(bus, 0.0))
            if level > 0.0:
                level *= float(bias.get(bus, 1.0))
                level *= 0.62 + 0.38 * energy
                level *= 1.0 + rng.uniform(-0.07, 0.07)
            activation[bus] = round(_clamp(level), 3)

        if role == "intro" and intro_bass_out:
            activation["bass"] = 0.0
        section["bus_activation"] = activation

        section["bus_variant"] = {
            bus: rng.randrange(max(1, int(pool.get(bus, 1)))) for bus in BUSES
        }
        section["fill_bars"] = _fill_bars_for(section, fill_probability, rng)

    arrangement: dict[str, Any] = {
        "seed": int(seed),
        "request_id": request_id,
        "prompt": prompt,
        "genre": profile["genre"],
        "family": profile["family"],
        "family_label": profile["label"],
        "matrix_source": profile.get("mastering_source"),
        "archetype_index": archetype_index,
        "bpm": float(bpm),
        "total_bars": int(sum(s["bars"] for s in sections)),
        "duration_sec": round(bars_to_seconds(sum(s["bars"] for s in sections), bpm), 3),
        "bus_target_rms_dbfs": dict(profile["bus_target_rms_dbfs"]),
        "variant_pool": dict(pool),
        "bass_centroid_hz": profile["bass_centroid_hz"],
        "vocal_centroid_hz": profile["vocal_centroid_hz"],
        "sections": sections,
    }
    return arrangement


def apply_arrangement_to_blueprint(
    blueprint: dict[str, Any],
    arrangement: dict[str, Any],
) -> dict[str, Any]:
    """Replace the blueprint's flat section list with the arrangement map.

    ``query_tags`` and ``dsp_filters`` are carried over from the blueprint
    section that best matches each new section role, so the corpus queries the
    arranger produced are not thrown away.
    """
    old_sections = list(blueprint.get("sections") or [])
    by_role: dict[str, dict[str, Any]] = {}
    for section in old_sections:
        role = normalise_section_role(section.get("name"))
        by_role.setdefault(role, section)
    fallback = old_sections[0] if old_sections else {}

    new_sections: list[dict[str, Any]] = []
    for section in arrangement["sections"]:
        role = "chorus" if section["predrop"] else section["role"]
        donor = by_role.get(role) or by_role.get("verse") or fallback
        activation = section["bus_activation"]
        new_sections.append(
            {
                "name": section["name"],
                "role": section["role"],
                "bars": int(section["bars"]),
                "slice_count": int(section["bars"]),
                "energy": float(section["energy"]),
                "volume_weights": {
                    "rhythm": activation["rhythm"],
                    "harmonic": activation["harmonic"],
                    "lead": activation["harmonic"],
                    "vocal": activation["vocal"],
                    "bass": activation["bass"],
                },
                "bus_activation": dict(activation),
                "bus_variant": dict(section["bus_variant"]),
                "fill_bars": list(section["fill_bars"]),
                "query_tags": dict(donor.get("query_tags") or {}),
                "dsp_filters": dict(donor.get("dsp_filters") or {}),
            }
        )

    blueprint["sections"] = new_sections
    meta = blueprint.setdefault("track_metadata", {})
    meta["total_bars"] = int(arrangement["total_bars"])
    meta["genre"] = arrangement["genre"] or meta.get("genre") or "alt_rock"
    blueprint["arrangement"] = {
        key: arrangement[key]
        for key in (
            "seed",
            "request_id",
            "genre",
            "family",
            "family_label",
            "archetype_index",
            "total_bars",
            "duration_sec",
            "bus_target_rms_dbfs",
            "variant_pool",
            "bass_centroid_hz",
            "vocal_centroid_hz",
            "conductor",
            "skeleton",
            "index_honesty",
            "matrix_source",
        )
        if key in arrangement
    }
    return blueprint


def describe_arrangement(arrangement: dict[str, Any]) -> str:
    """Human-readable section map, used by the CLI and the render report."""
    lines = [
        f"seed={arrangement['seed']} genre={arrangement['genre']} "
        f"family={arrangement['family']} archetype=#{arrangement['archetype_index']} "
        f"bars={arrangement['total_bars']} ({arrangement['duration_sec']:.1f}s @ "
        f"{arrangement['bpm']:.1f} BPM)",
        f"{'section':<14}{'bars':>5}{'energy':>8}"
        f"{'drums':>8}{'bass':>7}{'harm':>7}{'vocal':>7}  variants      fills",
    ]
    for section in arrangement["sections"]:
        act = section["bus_activation"]
        var = section["bus_variant"]
        variants = "/".join(str(var[bus]) for bus in BUSES)
        fills = ",".join(str(b) for b in section["fill_bars"]) or "-"
        lines.append(
            f"{section['name']:<14}{section['bars']:>5}{section['energy']:>8.2f}"
            f"{act['rhythm']:>8.2f}{act['bass']:>7.2f}"
            f"{act['harmonic']:>7.2f}{act['vocal']:>7.2f}"
            f"  {variants:<12}  {fills}"
        )
    return "\n".join(lines)


def arrangement_signature(arrangement: dict[str, Any]) -> tuple:
    """Comparable fingerprint of a section map (used by tests and the report)."""
    return tuple(
        (
            section["name"],
            section["bars"],
            tuple(round(section["bus_activation"][bus], 3) for bus in BUSES),
            tuple(section["bus_variant"][bus] for bus in BUSES),
            tuple(section["fill_bars"]),
        )
        for section in arrangement["sections"]
    )


if __name__ == "__main__":  # pragma: no cover - manual inspection helper
    import argparse

    parser = argparse.ArgumentParser(description="Print a seeded arrangement map")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--genre", default=None)
    parser.add_argument("--bpm", type=float, default=120.0)
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--request-id", default=None)
    args = parser.parse_args()
    plan = build_arrangement(
        args.prompt,
        args.genre,
        args.bpm,
        args.duration,
        request_id=args.request_id,
        explicit_seed=args.seed,
    )
    print(describe_arrangement(plan))
