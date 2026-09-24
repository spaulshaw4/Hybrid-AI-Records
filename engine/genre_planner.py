"""Executive arrangement planner — genre rulebook owns the mix, not the picker.

The corpus picker may only lock stems. Timing, mutes, filters, width, and
section development come from ``get_arrangement_blueprint(genre, total_bars)``.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

from engine.genre_arrangement_profiles import (
    ARRANGEMENT_FAMILIES,
    DEFAULT_FAMILY,
    family_for_genre,
    normalise_section_role,
)

# Prompt-book structural maps → Hybrid 1.0 DSP console commands.
# Catalog ids: prompt-book `cyberpunkdarks` / `electroswing`.
GENRE_BLUEPRINTS: dict[str, dict[str, dict[str, Any]]] = {
    "cyberpunk_darksynth": {
        # neon-cold arpeggios & glitches → adrenalized sub drops / industrial kick
        "intro":      {"drums_muted": True,  "bass_muted": True,  "sidechain_pump": 0.0, "lowpass_freq": 800,  "stereo_width": 0.8},
        "verse_1":    {"drums_muted": False, "bass_muted": True,  "sidechain_pump": 0.4, "lowpass_freq": 2000, "stereo_width": 1.0},
        "pre_chorus": {"drums_muted": False, "bass_muted": False, "sidechain_pump": 0.7, "lowpass_freq": 5000, "stereo_width": 1.1},
        "chorus_1":   {"drums_muted": False, "bass_muted": False, "sidechain_pump": 1.0, "lowpass_freq": None, "stereo_width": 1.3},
        "bridge":     {"drums_muted": True,  "bass_muted": False, "sidechain_pump": 0.2, "lowpass_freq": 1000, "stereo_width": 0.6},
        "outro":      {"drums_muted": False, "bass_muted": True,  "sidechain_pump": 0.0, "lowpass_freq": 600,  "stereo_width": 0.8},
    },
    "electroswing": {
        # speakeasy 78rpm / upright bass → roaring four-on-the-floor + brass
        "intro":      {"drums_muted": True,  "bass_muted": False, "sidechain_pump": 0.0, "lowpass_freq": 1000, "stereo_width": 0.5},
        "verse_1":    {"drums_muted": False, "bass_muted": False, "sidechain_pump": 0.2, "lowpass_freq": None, "stereo_width": 1.0},
        "pre_chorus": {"drums_muted": True,  "bass_muted": False, "sidechain_pump": 0.0, "lowpass_freq": None, "stereo_width": 1.1},
        "chorus_1":   {"drums_muted": False, "bass_muted": False, "sidechain_pump": 0.5, "lowpass_freq": None, "stereo_width": 1.25},
        "bridge":     {"drums_muted": False, "bass_muted": True,  "sidechain_pump": 0.0, "lowpass_freq": 3000, "stereo_width": 0.8},
        "outro":      {"drums_muted": True,  "bass_muted": True,  "sidechain_pump": 0.0, "lowpass_freq": 400,  "stereo_width": 0.5},
    },
}

_GENRE_ALIASES: dict[str, str] = {
    "cyberpunk_darksynth": "cyberpunk_darksynth",
    "cyberpunkdarksynth": "cyberpunk_darksynth",
    "cyberpunkdarks": "cyberpunk_darksynth",
    "cyberpunk": "cyberpunk_darksynth",
    "darksynth": "cyberpunk_darksynth",
    "electroswing": "electroswing",
    "electro_swing": "electroswing",
}

_CATALOG_FALLBACK: dict[str, Any] = {
    "drums_muted": False,
    "bass_muted": False,
    "sidechain_pump": 0.0,
    "lowpass_freq": None,
    "stereo_width": 1.0,
}

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
        state = get_section_blueprint(str(genre or ""), role_n)
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


def _plan_section_span(section: Any) -> tuple[str | None, int, int]:
    if isinstance(section, Mapping):
        name = section.get("name")
        start = int(section.get("start_bar") or 0)
        bars = int(section.get("bars") or 1)
    else:
        name = getattr(section, "name", None)
        start = int(getattr(section, "start_bar", 0) or 0)
        bars = int(getattr(section, "bars", 1) or 1)
    return name, start, max(1, bars)


def _normalize_genre_key(genre: str | None) -> str:
    """Fold prompt-book / UI labels onto ``GENRE_BLUEPRINTS`` keys."""
    clean = str(genre or "").lower().replace(" ", "_").replace("/", "").replace("-", "_")
    while "__" in clean:
        clean = clean.replace("__", "_")
    clean = clean.strip("_")
    if clean in GENRE_BLUEPRINTS:
        return clean
    if clean in _GENRE_ALIASES:
        return _GENRE_ALIASES[clean]
    if "darksynth" in clean or "cyberpunk" in clean:
        return "cyberpunk_darksynth"
    if "electroswing" in clean or "electro_swing" in clean:
        return "electroswing"
    return clean


def _catalog_section_key(section_name: str) -> str:
    """Map verse_2 / chorus_final onto the catalog slots (not the global clock)."""
    name = str(section_name or "").lower()
    if "intro" in name:
        return "intro"
    # Check pre-chorus before chorus — "pre_chorus" contains "chorus".
    if "pre" in name and "chorus" in name:
        return "pre_chorus"
    if "verse" in name:
        return "verse_1"
    if "chorus" in name:
        return "chorus_1"
    if "bridge" in name or "break" in name:
        return "bridge"
    if "outro" in name:
        return "outro"
    role = normalise_section_role(section_name)
    return {
        "intro": "intro",
        "verse": "verse_1",
        "pre_chorus": "pre_chorus",
        "build": "pre_chorus",
        "chorus": "chorus_1",
        "drop": "chorus_1",
        "solo": "chorus_1",
        "bridge": "bridge",
        "breakdown": "bridge",
        "outro": "outro",
    }.get(role, name or "verse_1")


def _family_as_catalog(state: Mapping[str, Any]) -> dict[str, Any]:
    """Translate family console rows into Hybrid 1.0 catalog commands."""
    token = state.get("rhythm_filter")
    cutoff: float | None = None
    if isinstance(token, (int, float)):
        cutoff = float(token)
    elif isinstance(token, str) and token.startswith("lowpass_"):
        digits = "".join(ch for ch in token if ch.isdigit())
        cutoff = float(digits) if digits else None
    drums_muted = not bool(state.get("drums_active", True))
    return {
        "drums_muted": drums_muted,
        "bass_muted": not bool(state.get("bass_active", True)),
        "sidechain_pump": (
            0.8 if state.get("rhythm_swell") else (0.0 if drums_muted else 0.3)
        ),
        "lowpass_freq": cutoff,
        "stereo_width": float(state.get("stereo_width") or 1.0),
        "kick_muted": bool(state.get("kick_muted")),
        "lead_active": bool(state.get("lead_active")),
        "breakdown": bool(state.get("breakdown")),
        "rhythm_swell": bool(state.get("rhythm_swell")),
        "volume": dict(state.get("volume") or {}),
    }


def _hydrate_console(raw: Mapping[str, Any], *, role: str, genre: str) -> dict[str, Any]:
    """Expand catalog commands into the keys ``apply_bar_dsp`` / mixer read."""
    drums_muted = bool(raw.get("drums_muted", False))
    bass_muted = bool(raw.get("bass_muted", False))
    lowpass = raw.get("lowpass_freq")
    cutoff = float(lowpass) if lowpass is not None else None
    pump = float(raw.get("sidechain_pump") or 0.0)
    width = float(raw.get("stereo_width") or 1.0)
    rhythm_filter = f"lowpass_{int(round(cutoff))}Hz" if cutoff else None
    return {
        "drums_muted": drums_muted,
        "bass_muted": bass_muted,
        "drums_active": not drums_muted,
        "bass_active": not bass_muted,
        "kick_muted": bool(raw.get("kick_muted", drums_muted)),
        "lead_active": bool(
            raw.get(
                "lead_active",
                role in {"chorus", "pre_chorus", "bridge", "solo", "drop", "build"},
            )
        ),
        "sidechain_pump": pump,
        "lowpass_freq": cutoff,
        "rhythm_filter": rhythm_filter,
        "stereo_width": width,
        "rhythm_swell": bool(raw.get("rhythm_swell")) or pump >= 0.8,
        "breakdown": bool(raw.get("breakdown")) or (drums_muted and role == "bridge"),
        "volume": dict(raw.get("volume") or {}),
        "role": role,
        "genre": genre,
    }


def genre_from_plan(plan: Any) -> str:
    """Genre string the mixer / assembler must use — picker never supplies this."""
    if plan is None:
        return ""
    meta: Any = {}
    sources: Any = []
    if isinstance(plan, Mapping):
        meta = plan.get("core_metadata") or {}
        sources = plan.get("source_genres") or []
        direct = str(plan.get("genre") or plan.get("genre_hint") or "").strip()
        if direct:
            return direct
    else:
        meta = getattr(plan, "core_metadata", None) or {}
        sources = getattr(plan, "source_genres", None) or []
    if isinstance(meta, Mapping):
        for key in ("genre", "genre_hint", "genre_lock"):
            val = str(meta.get(key) or "").strip()
            if val:
                return val
    if sources:
        first = sources[0]
        if isinstance(first, Mapping):
            val = str(first.get("genre") or first.get("slug") or "").strip()
            if val:
                return val
        else:
            val = str(first or "").strip()
            if val:
                return val
    return ""


def get_section_blueprint(genre: str, section_name: str) -> dict[str, Any]:
    """Fetch DSP rules based on the specific genre and section being rendered."""
    clean_genre = _normalize_genre_key(genre)
    # Fallback to electroswing if the specific genre is not yet mapped
    resolved = clean_genre if clean_genre in GENRE_BLUEPRINTS else "electroswing"
    blueprint_map = GENRE_BLUEPRINTS[resolved]

    name = str(section_name or "")
    base_section = _catalog_section_key(name)
    raw = dict(blueprint_map.get(base_section) or _CATALOG_FALLBACK)
    return _hydrate_console(
        raw,
        role=normalise_section_role(section_name),
        genre=resolved,
    )


def rules_for_plan_bar(
    blueprint: Mapping[str, Any],
    bar: int,
    plan_sections: Sequence[Any] | None = None,
) -> dict[str, Any]:
    """Planner DSP for a bar: the song plan names the section, the rulebook mixes it."""
    genre = str(blueprint.get("genre") or blueprint.get("family") or "")
    if plan_sections:
        idx = max(0, int(bar))
        for section in plan_sections:
            name, start, bars = _plan_section_span(section)
            if start <= idx < start + bars:
                return get_section_blueprint(genre, str(name or "verse"))
    planned = rules_for_bar(blueprint, bar)
    return get_section_blueprint(genre, str(planned.get("role") or planned.get("name") or "verse"))


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
        "drums_muted": not drums,
        "kick_muted": bool(state.get("kick_muted")),
        "bass_active": bass,
        "bass_muted": not bass,
        "lead_active": bool(state.get("lead_active")),
        "rhythm_filter": state.get("rhythm_filter"),
        "lowpass_freq": state.get("lowpass_freq"),
        "sidechain_pump": float(state.get("sidechain_pump") or 0.0),
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
    _ = total_bars
    return get_section_blueprint(str(genre or ""), str(section_name or ""))
