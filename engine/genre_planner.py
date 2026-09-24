"""Executive arrangement planner — genre rulebook owns the mix, not the picker.

The corpus picker may only lock stems. Timing, mutes, filters, width, and
section development come from ``get_arrangement_blueprint(genre, total_bars)``.
"""
from __future__ import annotations

from typing import Any, Mapping

from engine.genre_arrangement_profiles import (
    ARRANGEMENT_FAMILIES,
    DEFAULT_FAMILY,
    family_for_genre,
    normalise_section_role,
)

# Development style per arrangement family.
FAMILY_STYLE: dict[str, str] = {
    "hiphop_rnb": "subtractive",      # loops stay; 808 / kick drop in and out
    "rock_metal": "linear_stack",     # instruments stack; tight verse, wide chorus
    "electronic_club": "build_drop",  # filter opens into the drop
    "pop_dance": "hook_lift",         # pre-chorus lift, wide chorus
    "jazz_roots": "head_solo",        # head in, solo space, head out
    "world_latin": "call_response",   # percussion stays, harmonic answers
    "cinematic_ambient": "swell",     # slow reveal, drums late
    "other": "hybrid",
}

# Executive console state per family + role. Volume is 0–1 linear on each bus.
# The picker never writes these fields.
_COMMON_INTRO = {
    "drums_active": False,
    "kick_muted": True,
    "bass_active": False,
    "lead_active": False,
    "rhythm_filter": "lowpass_600Hz",
    "stereo_width": 0.5,
    "rhythm_swell": False,
    "breakdown": False,
    "volume": {"rhythm": 0.0, "bass": 0.0, "harmonic": 0.70, "vocal": 0.0, "lead": 0.0},
}
_COMMON_OUTRO = {
    "drums_active": False,
    "kick_muted": True,
    "bass_active": False,
    "lead_active": False,
    "rhythm_filter": "lowpass_600Hz",
    "stereo_width": 0.6,
    "rhythm_swell": False,
    "breakdown": False,
    "volume": {"rhythm": 0.25, "bass": 0.15, "harmonic": 0.55, "vocal": 0.0, "lead": 0.0},
}

FAMILY_SECTION_RULES: dict[str, dict[str, dict[str, Any]]] = {
    "hiphop_rnb": {
        # Subtractive: same loop, 808 and kick enter/exit.
        "intro": {**_COMMON_INTRO, "volume": {"rhythm": 0.0, "bass": 0.0, "harmonic": 0.55, "vocal": 0.0, "lead": 0.0}},
        "verse": {
            "drums_active": True,
            "kick_muted": True,  # hats / snaps only — 808 later
            "bass_active": True,
            "lead_active": False,
            "rhythm_filter": "lowpass_2000Hz",
            "stereo_width": 0.7,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.75, "bass": 0.85, "harmonic": 0.45, "vocal": 0.90, "lead": 0.0},
        },
        "pre_chorus": {
            "drums_active": True,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": False,
            "rhythm_filter": None,
            "stereo_width": 0.85,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.80, "bass": 0.0, "harmonic": 0.65, "vocal": 0.70, "lead": 0.20},
        },
        "chorus": {
            "drums_active": True,
            "kick_muted": False,  # 808 + kick drop
            "bass_active": True,
            "lead_active": True,
            "rhythm_filter": None,
            "stereo_width": 1.15,
            "rhythm_swell": True,
            "breakdown": False,
            "volume": {"rhythm": 1.0, "bass": 1.0, "harmonic": 0.70, "vocal": 1.0, "lead": 0.85},
        },
        "bridge": {
            "drums_active": False,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": False,
            "rhythm_filter": "lowpass_600Hz",
            "stereo_width": 0.6,
            "rhythm_swell": False,
            "breakdown": True,
            "volume": {"rhythm": 0.0, "bass": 0.0, "harmonic": 0.80, "vocal": 0.75, "lead": 0.0},
        },
        "outro": _COMMON_OUTRO,
    },
    "rock_metal": {
        # Linear stack: tight verse, wide chorus, instruments add rather than drop-swap.
        "intro": {
            "drums_active": True,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": False,
            "rhythm_filter": "lowpass_2000Hz",
            "stereo_width": 0.65,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.55, "bass": 0.0, "harmonic": 0.75, "vocal": 0.0, "lead": 0.15},
        },
        "verse": {
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "lead_active": False,
            "rhythm_filter": None,
            "stereo_width": 0.75,  # tight verse
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.85, "bass": 0.80, "harmonic": 0.70, "vocal": 0.80, "lead": 0.10},
        },
        "pre_chorus": {
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "lead_active": True,
            "rhythm_filter": None,
            "stereo_width": 0.95,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.92, "bass": 0.75, "harmonic": 0.85, "vocal": 0.60, "lead": 0.55},
        },
        "chorus": {
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "lead_active": True,
            "rhythm_filter": None,
            "stereo_width": 1.25,  # wide chorus
            "rhythm_swell": True,
            "breakdown": False,
            "volume": {"rhythm": 1.0, "bass": 1.0, "harmonic": 0.95, "vocal": 1.0, "lead": 0.90},
        },
        "bridge": {
            "drums_active": False,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": True,
            "rhythm_filter": "lowpass_1000Hz",
            "stereo_width": 0.7,
            "rhythm_swell": False,
            "breakdown": True,
            "volume": {"rhythm": 0.0, "bass": 0.0, "harmonic": 0.85, "vocal": 0.55, "lead": 0.70},
        },
        "outro": _COMMON_OUTRO,
    },
    "electronic_club": {
        "intro": {**_COMMON_INTRO, "rhythm_filter": "lowpass_400Hz"},
        "verse": {
            "drums_active": True,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": False,
            "rhythm_filter": "lowpass_1000Hz",
            "stereo_width": 0.75,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.70, "bass": 0.0, "harmonic": 0.80, "vocal": 0.40, "lead": 0.20},
        },
        "pre_chorus": {
            "drums_active": True,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": True,
            "rhythm_filter": "lowpass_2000Hz",
            "stereo_width": 0.95,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.85, "bass": 0.0, "harmonic": 0.90, "vocal": 0.30, "lead": 0.50},
        },
        "chorus": {  # drop
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "lead_active": True,
            "rhythm_filter": None,
            "stereo_width": 1.20,
            "rhythm_swell": True,
            "breakdown": False,
            "volume": {"rhythm": 1.0, "bass": 1.0, "harmonic": 0.75, "vocal": 0.50, "lead": 0.80},
        },
        "bridge": {
            "drums_active": False,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": False,
            "rhythm_filter": "lowpass_600Hz",
            "stereo_width": 0.55,
            "rhythm_swell": False,
            "breakdown": True,
            "volume": {"rhythm": 0.0, "bass": 0.0, "harmonic": 0.90, "vocal": 0.40, "lead": 0.15},
        },
        "outro": _COMMON_OUTRO,
    },
    "pop_dance": {
        "intro": _COMMON_INTRO,
        "verse": {
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "lead_active": False,
            "rhythm_filter": None,
            "stereo_width": 0.80,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.80, "bass": 0.70, "harmonic": 0.65, "vocal": 0.85, "lead": 0.10},
        },
        "pre_chorus": {
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "lead_active": True,
            "rhythm_filter": None,
            "stereo_width": 0.95,
            "rhythm_swell": False,
            "breakdown": False,
            "volume": {"rhythm": 0.88, "bass": 0.65, "harmonic": 0.80, "vocal": 0.70, "lead": 0.45},
        },
        "chorus": {
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "lead_active": True,
            "rhythm_filter": None,
            "stereo_width": 1.20,
            "rhythm_swell": True,
            "breakdown": False,
            "volume": {"rhythm": 1.0, "bass": 0.95, "harmonic": 0.90, "vocal": 1.0, "lead": 0.85},
        },
        "bridge": {
            "drums_active": False,
            "kick_muted": True,
            "bass_active": False,
            "lead_active": False,
            "rhythm_filter": "lowpass_1000Hz",
            "stereo_width": 0.65,
            "rhythm_swell": False,
            "breakdown": True,
            "volume": {"rhythm": 0.0, "bass": 0.0, "harmonic": 0.80, "vocal": 0.60, "lead": 0.20},
        },
        "outro": _COMMON_OUTRO,
    },
}

# Role aliases used when an archetype names drop/build/breakdown/solo.
_ROLE_RULE_FALLBACK = {
    "build": "pre_chorus",
    "drop": "chorus",
    "breakdown": "bridge",
    "solo": "chorus",
}


def _rules_table(family: str) -> dict[str, dict[str, Any]]:
    if family in FAMILY_SECTION_RULES:
        return FAMILY_SECTION_RULES[family]
    if family in {"jazz_roots", "world_latin"}:
        return FAMILY_SECTION_RULES["pop_dance"]
    if family == "cinematic_ambient":
        return FAMILY_SECTION_RULES["electronic_club"]
    return FAMILY_SECTION_RULES["pop_dance"]


def section_console_state(family: str, role: str) -> dict[str, Any]:
    """Mix-console commands for one family + section role."""
    table = _rules_table(family)
    key = role if role in table else _ROLE_RULE_FALLBACK.get(role, "verse")
    state = dict(table.get(key) or table["verse"])
    state["volume"] = dict(state.get("volume") or {})
    if state.get("breakdown"):
        state["drums_active"] = False
        state["bass_active"] = False
        state["volume"]["rhythm"] = 0.0
        state["volume"]["bass"] = 0.0
    return state


def _scale_archetype(archetype: list, total_bars: int) -> list[tuple[str, int]]:
    """Fit the family's first archetype onto ``total_bars`` (integers sum exact)."""
    wanted = max(1, int(total_bars))
    raw: list[tuple[str, int]] = []
    for item in archetype:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            role = str(item[0])
            counts = item[1]
            bars = int(counts[0]) if isinstance(counts, (list, tuple)) else int(counts)
        else:
            continue
        raw.append((role, max(1, bars)))
    if not raw:
        raw = [
            ("intro", 4),
            ("verse", 8),
            ("pre_chorus", 4),
            ("chorus", 8),
            ("bridge", 4),
            ("outro", 4),
        ]
    total = sum(b for _r, b in raw)
    scaled = [max(1, int(round(b * wanted / total))) for _r, b in raw]
    drift = wanted - sum(scaled)
    # Push leftover bars onto the longest section (usually a chorus / verse).
    longest = max(range(len(scaled)), key=lambda i: scaled[i])
    scaled[longest] = max(1, scaled[longest] + drift)
    while sum(scaled) > wanted and any(x > 1 for x in scaled):
        idx = max(range(len(scaled)), key=lambda i: scaled[i])
        if scaled[idx] <= 1:
            break
        scaled[idx] -= 1
    return [(raw[i][0], scaled[i]) for i in range(len(raw))]


def get_arrangement_blueprint(genre: str | None, total_bars: int) -> dict[str, Any]:
    """Structural mix state for every section, scaled to ``total_bars``.

    The picker must not invent arrangement from this return — it is the
    executive plan the assembler / mixer is required to execute.
    """
    family = family_for_genre(genre)
    style = FAMILY_STYLE.get(family, "hybrid")
    base = ARRANGEMENT_FAMILIES.get(family) or ARRANGEMENT_FAMILIES[DEFAULT_FAMILY]
    archetypes = base.get("archetypes") or []
    template = archetypes[0] if archetypes else []
    layout = _scale_archetype(template, total_bars)

    sections: list[dict[str, Any]] = []
    cursor = 0
    for role, bars in layout:
        role_n = normalise_section_role(role)
        state = section_console_state(family, role_n)
        sections.append(
            {
                "name": role_n,
                "role": role_n,
                "start_bar": cursor,
                "bars": int(bars),
                **state,
            }
        )
        cursor += int(bars)

    return {
        "genre": str(genre or family),
        "family": family,
        "style": style,
        "total_bars": max(1, int(total_bars)),
        "authority": "genre_planner",
        "sections": sections,
    }


def rules_for_bar(blueprint: Mapping[str, Any], bar: int) -> dict[str, Any]:
    """Console state for an absolute bar index."""
    sections = list(blueprint.get("sections") or [])
    if not sections:
        return section_console_state(DEFAULT_FAMILY, "verse")
    idx = max(0, int(bar))
    for section in sections:
        start = int(section.get("start_bar") or 0)
        end = start + int(section.get("bars") or 1)
        if start <= idx < end:
            return dict(section)
    return dict(sections[-1])


def dsp_rules_from_section(state: Mapping[str, Any]) -> dict[str, Any]:
    """Shape consumed by ``apply_bar_dsp`` / the relational mixer."""
    width = state.get("stereo_width", 1.0)
    if width == "wide":
        width = 1.25
    elif width == "tight":
        width = 0.7
    breakdown = bool(state.get("breakdown"))
    drums = bool(state.get("drums_active", True)) and not breakdown
    bass = bool(state.get("bass_active", True)) and not breakdown
    return {
        "drums_active": drums,
        "kick_muted": bool(state.get("kick_muted")),
        "bass_active": bass,
        "lead_active": bool(state.get("lead_active")),
        "rhythm_filter": state.get("rhythm_filter"),
        "stereo_width": float(width or 1.0),
        "rhythm_swell": bool(state.get("rhythm_swell")),
        "breakdown": breakdown,
        "volume": dict(state.get("volume") or {}),
        "role": str(state.get("role") or state.get("name") or "verse"),
    }


def apply_executive_mix(
    stems: Mapping[str, Any],
    rules: Mapping[str, Any],
    sr: int,
    bpm: float,
    *,
    beats_per_bar: float = 4.0,
) -> dict[str, Any]:
    """Run planner DSP on in-memory stems. Lazy import avoids mixer cycles."""
    from engine.conductor_matrix import apply_bar_dsp

    return apply_bar_dsp(dict(stems), rules, int(sr), float(bpm), beats_per_bar=beats_per_bar)


def rules_for_named_section(
    genre: str | None,
    section_name: str | None,
    *,
    total_bars: int = 32,
) -> dict[str, Any]:
    """Look up executive rules from a section name (mixer path)."""
    blueprint = get_arrangement_blueprint(genre, total_bars)
    role = normalise_section_role(section_name)
    for section in blueprint.get("sections") or []:
        if section.get("role") == role:
            return dsp_rules_from_section(section)
    return dsp_rules_from_section(section_console_state(family_for_genre(genre), role))
