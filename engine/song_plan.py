"""Global Song Plan — master contract before any audio buffers are touched.

Every stem generator, retrieval query, and mixer rule must adhere to a
``GlobalSongPlan`` instance. Build the plan first; query SQLite second.

Relational mixer fields under ``MixIntents`` are stubs for Module 2 (frequency
masking, kick->bass ducking, shared reverb bus).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence

import numpy as np

from pydantic import BaseModel, ConfigDict, Field

from engine.genre_arrangement_profiles import normalise_section_role
from engine.genre_feature_vector import (
    VECTOR_AXES,
    arrangement_nudges_from_vector,
    clamp01,
    resolve_genre_vector,
)

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_SHARP_TO_FLAT = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}
_FLAT_TO_SHARP = {
    "DB": "C#",
    "EB": "D#",
    "GB": "F#",
    "AB": "G#",
    "BB": "A#",
}
# Key signatures that use flats. Relative minors included so G minor spells
# Bb and Eb, not A# and D# (those read as a different song).
_FLAT_MAJOR_ROOTS = {"F", "Bb", "Eb", "Ab", "Db", "Gb"}
_FLAT_MINOR_ROOTS = {"D", "G", "C", "F", "Bb", "Eb"}
# Country / folk songs want triads in one key, not jazz 9ths on every degree.
_TRIAD_GENRE_TOKENS = ("country", "folk", "bluegrass", "americana", "outlaw", "honky")

# Diatonic roman templates keyed by scale family.
_PROGRESSIONS: dict[str, list[str]] = {
    "minor": ["i", "VI", "III", "VII"],
    "natural_minor": ["i", "VI", "III", "VII"],
    "aeolian": ["i", "VI", "III", "VII"],
    "dorian": ["i", "IV", "VII", "III"],
    "phrygian": ["i", "II", "III", "VII"],
    "major": ["I", "V", "vi", "IV"],
    "ionian": ["I", "V", "vi", "IV"],
    "mixolydian": ["I", "bVII", "IV", "I"],
    "lydian": ["I", "II", "V", "I"],
    "harmonic_minor": ["i", "iv", "V", "i"],
}

_MINOR_ROMAN = {"i", "ii", "iii", "iv", "v", "vi", "vii", "ii°", "vii°"}

# Functional progressions per section role. Verses sit on tension degrees,
# pre-choruses climb to the dominant, choruses resolve to the tonic, bridges
# move away from both. Modes outside these families use their scale template.
_ROLE_PROGRESSIONS: dict[str, dict[str, list[str]]] = {
    "major": {
        "intro": ["I", "IV"],
        "verse": ["vi", "IV", "I", "V"],
        "pre_chorus": ["ii", "IV", "V", "V"],
        "build": ["IV", "V"],
        "chorus": ["I", "V", "vi", "IV"],
        "drop": ["I", "V", "vi", "IV"],
        "bridge": ["IV", "V", "iii", "vi"],
        "breakdown": ["vi", "IV"],
        "solo": ["I", "V", "vi", "IV"],
        "outro": ["IV", "V", "I", "I"],
    },
    "minor": {
        "intro": ["i", "VI"],
        "verse": ["i", "VI", "III", "VII"],
        "pre_chorus": ["iv", "VI", "VII", "VII"],
        "build": ["VI", "VII"],
        "chorus": ["VI", "VII", "i", "i"],
        "drop": ["i", "VI", "III", "VII"],
        "bridge": ["iv", "VI", "VII", "v"],
        "breakdown": ["VI", "iv"],
        "solo": ["i", "VI", "III", "VII"],
        "outro": ["VI", "VII", "i", "i"],
    },
}
_ROLE_PROGRESSION_FAMILY = {
    "major": "major",
    "ionian": "major",
    "minor": "minor",
    "natural_minor": "minor",
    "aeolian": "minor",
}


def _prefer_flats(root: str, scale: str) -> bool:
    mode = str(scale or "").lower()
    if mode in {"minor", "natural_minor", "aeolian", "dorian", "phrygian", "harmonic_minor"}:
        return root in _FLAT_MINOR_ROOTS
    return root in _FLAT_MAJOR_ROOTS


def chord_density_for_song(genre: str | None, prompt: str | None, density: float) -> float:
    """Cap extensions when the song is roots music, not a jazz chart."""
    haystack = f"{genre or ''} {prompt or ''}".lower()
    if any(token in haystack for token in _TRIAD_GENRE_TOKENS):
        return min(float(density), 0.40)
    return float(density)


def bars_per_chord_for(bars: int) -> int:
    """Two-bar harmonic rhythm in full sections, one bar in short ones."""
    return 2 if int(bars) >= 8 else 1


def role_progression(scale: str, role: str, density: float) -> list[str]:
    family = _ROLE_PROGRESSION_FAMILY.get(str(scale).lower())
    if family:
        table = _ROLE_PROGRESSIONS[family]
        romans = table.get(normalise_section_role(role)) or table["verse"]
        return list(romans)
    return _progression_for(scale, density)

# Role -> stems that typically play in that section (assembler bus names).
_ROLE_STEMS: dict[str, list[str]] = {
    "intro": ["drums", "pads", "rhythm_guitar"],
    "verse": ["drums", "bass", "rhythm_guitar", "lead_vocal"],
    "pre_chorus": ["drums", "bass", "rhythm_guitar", "lead_vocal", "synth"],
    "build": ["drums", "bass", "synth", "fx"],
    "chorus": ["drums", "bass", "rhythm_guitar", "lead_guitar", "lead_vocal", "pads"],
    "drop": ["drums", "bass", "synth", "fx"],
    "bridge": ["drums", "bass", "pads", "lead_vocal"],
    "breakdown": ["pads", "lead_vocal", "fx"],
    "solo": ["drums", "bass", "lead_guitar"],
    "outro": ["drums", "pads", "rhythm_guitar"],
    "pre_drop": ["drums", "fx"],
}

_FREQ_RESERVATIONS = {
    "kick": "40Hz-90Hz",
    "bass": "60Hz-200Hz",
    "lead_vocal": "1kHz-3kHz",
    "synth_lead": "1kHz-3kHz",
    "pads": "200Hz-2kHz",
}


class GenreVector(BaseModel):
    """Normalized multi-dimensional representation of genre traits."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    harmonic_complexity: float = Field(
        0.5, ge=0.0, le=1.0
    )  # Simple triads (0.0) -> Extended jazz/modal (1.0)
    rhythmic_syncopation: float = Field(
        0.5, ge=0.0, le=1.0
    )  # Quantized grid (0.0) -> Heavy polyrhythm/swing (1.0)
    spectral_aggression: float = Field(
        0.5, ge=0.0, le=1.0
    )  # Acoustic clean (0.0) -> Saturated/distorted (1.0)
    dynamic_headroom: float = Field(
        0.5, ge=0.0, le=1.0
    )  # Constant brickwall (0.0) -> Wide crest factor (1.0)
    spatial_depth: float = Field(
        0.5, ge=0.0, le=1.0
    )  # Dry/intimate (0.0) -> Expansive reverb tail (1.0)


class MixIntents(BaseModel):
    """Relational mixer stubs consumed by Module 2 DSP."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    sidechain_kick_bass: float = Field(
        0.35, ge=0.0, le=1.0, description="Kick->bass duck depth"
    )
    vocal_pocket_db: float = Field(
        2.0, ge=0.0, le=6.0, description="Mid duck on competing stems when vocal is active"
    )
    shared_reverb_bus: float = Field(
        0.18, ge=0.0, le=0.5, description="Dry-stem send into shared convolution bus"
    )
    frequency_mask_mid_db: float = Field(
        3.0, ge=0.0, le=6.0, description="Dynamic EQ cut when vocal+synth collide 1-3 kHz"
    )


class SectionPlan(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str  # "intro", "verse_1", "chorus_1", etc.
    start_bar: int
    bars: int
    energy_level: float = Field(..., ge=0.0, le=1.0)  # 0.2 (sparse) to 1.0 (climax)
    chord_progression: List[str]  # e.g., ["Em", "C", "G", "D"]
    active_stems: List[str]  # e.g., ["drums", "bass", "rhythm_guitar"]
    frequency_reservations: Dict[str, str]  # e.g., {"lead_vocal": "1kHz-3kHz"}
    # Harmonic rhythm: each chord lasts this many bars, cycling across the section.
    bars_per_chord: int = Field(1, ge=1, le=8)


class GlobalSongPlan(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    title: str
    key: str  # e.g., "E"
    scale: str  # "minor", "dorian", "mixolydian", etc.
    bpm: int = Field(..., ge=40, le=240)
    time_signature: str = "4/4"
    total_bars: int
    genre_blend: GenreVector
    sections: List[SectionPlan]
    master_lufs_target: float = -14.0
    true_peak_limit: float = -1.0
    # Engine-only extensions (still part of the master contract JSON).
    seed: int = 0
    request_id: str = ""
    source_genres: List[Dict[str, Any]] = Field(default_factory=list)
    mix_intents: MixIntents = Field(default_factory=MixIntents)
    core_metadata: Dict[str, Any] = Field(default_factory=dict)
    structural_array: List[str] = Field(default_factory=list)
    energy_arc: List[Dict[str, Any]] = Field(default_factory=list)
    harmonic_roadmap: List[Dict[str, Any]] = Field(default_factory=list)
    arrangement_nudges: Dict[str, Any] = Field(default_factory=dict)


DEFAULT_TIME_SIGNATURE = "4/4"
_TIME_SIGNATURE_RE = re.compile(r"^\s*(\d{1,2})\s*/\s*(\d{1,2})\s*$")


def beats_per_bar(time_signature: str | None) -> float:
    """Quarter-note beats per bar for a ``N/D`` time signature (BPM counts quarters).

    ``4/4`` → 4, ``3/4`` → 3, ``6/8`` → 3, ``7/8`` → 3.5. Invalid or missing
    signatures fall back to 4/4.
    """
    match = _TIME_SIGNATURE_RE.match(str(time_signature or DEFAULT_TIME_SIGNATURE))
    if not match:
        return 4.0
    numerator, denominator = int(match.group(1)), int(match.group(2))
    if numerator <= 0 or denominator not in {1, 2, 4, 8, 16, 32}:
        return 4.0
    return float(numerator) * 4.0 / float(denominator)


def parse_key_scale(raw: str | None, default_key: str = "E", default_scale: str = "minor") -> tuple[str, str]:
    """Accept ``E_minor``, ``E minor``, ``Em``, ``E``, etc."""
    text = str(raw or "").strip()
    if not text:
        return default_key, default_scale
    compact = text.replace("-", "_").replace(" ", "_")
    m = re.match(
        r"^([A-Ga-g](?:#|b)?)[_\s]*(major|minor|maj|min|dorian|mixolydian|lydian|"
        r"phrygian|aeolian|ionian|harmonic_minor)?$",
        compact,
        re.IGNORECASE,
    )
    if m:
        note = m.group(1).upper().replace("B#", "C").replace("E#", "F")
        note = _FLAT_TO_SHARP.get(note, note)
        if note not in NOTE_NAMES and len(note) == 2 and note[1] == "B":
            note = _FLAT_TO_SHARP.get(note, note)
        scale_raw = (m.group(2) or default_scale).lower()
        scale_map = {"maj": "major", "min": "minor"}
        scale = scale_map.get(scale_raw, scale_raw)
        return note if note in NOTE_NAMES else default_key, scale or default_scale

    # Trailing m / maj shorthand: Em, Emaj
    m2 = re.match(r"^([A-Ga-g](?:#|b)?)(m|maj|min)?$", text.replace(" ", ""), re.IGNORECASE)
    if m2:
        note = m2.group(1).upper()
        note = _FLAT_TO_SHARP.get(note, note)
        suffix = (m2.group(2) or "").lower()
        scale = "minor" if suffix in {"m", "min"} else ("major" if suffix == "maj" else default_scale)
        return note if note in NOTE_NAMES else default_key, scale
    return default_key, default_scale


def _scale_pc_offsets(scale: str) -> list[int]:
    tables = {
        "major": [0, 2, 4, 5, 7, 9, 11],
        "ionian": [0, 2, 4, 5, 7, 9, 11],
        "minor": [0, 2, 3, 5, 7, 8, 10],
        "natural_minor": [0, 2, 3, 5, 7, 8, 10],
        "aeolian": [0, 2, 3, 5, 7, 8, 10],
        "dorian": [0, 2, 3, 5, 7, 9, 10],
        "phrygian": [0, 1, 3, 5, 7, 8, 10],
        "mixolydian": [0, 2, 4, 5, 7, 9, 10],
        "lydian": [0, 2, 4, 6, 7, 9, 11],
        "harmonic_minor": [0, 2, 3, 5, 7, 8, 11],
    }
    return list(tables.get(scale.lower(), tables["minor"]))


def _roman_to_chord(root: str, scale: str, roman: str, density: float) -> str:
    """Render a roman numeral into a concrete chord symbol for ``root``/``scale``."""
    token = roman.strip()
    flat = token.startswith("b")
    if flat:
        token = token[1:]
    diminished = "°" in token or "dim" in token.lower()
    token_clean = token.replace("°", "").replace("dim", "")
    degree_map = {"i": 0, "ii": 1, "iii": 2, "iv": 3, "v": 4, "vi": 5, "vii": 6}
    deg = degree_map.get(token_clean.lower())
    if deg is None:
        return f"{root}{'m' if scale.endswith('minor') or scale in {'dorian', 'phrygian', 'aeolian'} else ''}"

    pcs = _scale_pc_offsets(scale)
    root_pc = NOTE_NAMES.index(root) if root in NOTE_NAMES else 4
    pc = (root_pc + pcs[deg % len(pcs)] - (1 if flat else 0)) % 12
    name = NOTE_NAMES[pc]
    if _prefer_flats(root, scale):
        name = _SHARP_TO_FLAT.get(name, name)
    # Case carries quality: lowercase numerals are minor, uppercase major.
    is_minor = token_clean in _MINOR_ROMAN and not diminished
    quality = "dim" if diminished else ("m" if is_minor else "")
    if density >= 0.75:
        quality = ("m9" if is_minor else "maj9") if not diminished else "dim7"
    elif density >= 0.45:
        dominant = token_clean.upper() == "V" and not is_minor
        seventh = "7" if dominant else "maj7"
        quality = ("m7" if is_minor else seventh) if not diminished else "dim7"
    elif is_minor:
        quality = "m"
    else:
        quality = ""
    return f"{name}{quality}"


def _split_roman(roman: str) -> tuple[str, str]:
    """``i9`` -> (``i``, ``9``). The degree keeps its case; the suffix is the color."""
    token = str(roman or "").strip()
    flat = token.startswith("b")
    body = token[1:] if flat else token
    for suffix in ("maj9", "maj7", "m11", "m9", "m7", "sus4", "sus2", "add9", "13", "11", "9", "7", "5"):
        if body.lower().endswith(suffix) and len(body) > len(suffix):
            degree = ("b" if flat else "") + body[: -len(suffix)]
            return degree, suffix.lower()
    return token, ""


def _grammar_chord(root: str, scale: str, roman: str, grammar: Any) -> str:
    """Spell one numeral with only the colors that archetype allows.

    Minor degrees stay triads unless the archetype asked for m7/m9/m11.
    Major I, IV, and V take a dominant 7 when that color is allowed.
    Power chords replace major triads only when ``power`` is the palette
    and a plain triad was not also requested for that degree.
    """
    degree, asked = _split_roman(roman)
    triad = _roman_to_chord(root, scale, degree, 0.2)
    minor = triad.endswith("m")
    base = triad[:-1] if minor else triad
    allowed = {str(item) for item in grammar.allowed_chords}
    forbidden = {str(item) for item in grammar.forbidden_chords}
    degree_name = degree[1:] if degree.startswith("b") else degree

    def permit(color: str) -> bool:
        return color in allowed and color not in forbidden

    if asked == "sus2" and permit("sus2"):
        return f"{base}sus2"
    if asked == "sus4" and permit("sus4"):
        return f"{base}sus4"
    if minor:
        if asked in {"11", "m11"} and permit("m11"):
            return f"{base}m11"
        if asked in {"9", "m9"} and (permit("m9") or "9th" in allowed):
            return f"{base}m9"
        if "triad" in allowed or "minor_chord_loop" in allowed:
            if asked in {"7", "m7"} and permit("m7"):
                return f"{base}m7"
            return f"{base}m"
        if permit("m9") or "9th" in allowed:
            return f"{base}m9"
        if permit("m7"):
            return f"{base}m7"
        if permit("m11"):
            return f"{base}m11"
        if permit("power"):
            return f"{base}5"
        return f"{base}m"
    degree_upper = degree_name.upper()
    dominant_ok = "dom7_natural" not in forbidden and "dom7" not in forbidden
    if degree_upper == "V" and permit("dom7") and dominant_ok:
        return f"{base}7"
    if degree_upper in {"I", "IV"} and permit("dom7") and "maj7" not in allowed and dominant_ok:
        return f"{base}7"
    if permit("maj7"):
        return f"{base}maj7"
    if permit("maj9"):
        return f"{base}maj9"
    if permit("13"):
        return f"{base}13"
    if permit("power") and "triad" not in allowed:
        return f"{base}5"
    if permit("power") and degree_upper not in {"I", "IV", "V"}:
        return f"{base}5"
    if permit("add9"):
        return f"{base}add9"
    if permit("sus4") and "triad" not in allowed:
        return f"{base}sus4"
    return base


def _chords_for_romans(root: str, scale: str, romans: list[str], density: float, grammar: Any) -> list[str]:
    if grammar is None:
        return [_roman_to_chord(root, scale, roman, density) for roman in romans]
    return [_grammar_chord(root, scale, roman, grammar) for roman in romans]


def _progression_for(scale: str, density: float) -> list[str]:
    romans = list(_PROGRESSIONS.get(scale.lower(), _PROGRESSIONS["minor"]))
    if density < 0.35:
        return romans[:3] if len(romans) >= 3 else romans
    if density >= 0.75 and len(romans) >= 4:
        # Extend with a secondary dominant colour as roman; rendered later.
        return romans + ["V"]
    return romans


def _active_stems_for(role: str, energy: float, activation: Mapping[str, float] | None = None) -> list[str]:
    base = list(_ROLE_STEMS.get(role, ["drums", "bass", "rhythm_guitar"]))
    if activation:
        # Drop stems whose bus is effectively muted.
        bus_to_stems = {
            "rhythm": {"drums"},
            "bass": {"bass"},
            "harmonic": {"rhythm_guitar", "pads", "synth", "lead_guitar"},
            "vocal": {"lead_vocal"},
        }
        muted: set[str] = set()
        for bus, stems in bus_to_stems.items():
            if float(activation.get(bus, 0.0)) <= 0.05:
                muted |= stems
        base = [s for s in base if s not in muted]
    if energy < 0.35:
        base = [s for s in base if s not in {"lead_guitar", "fx"}]
    return base or ["drums"]


def _frequency_reservations_for(stems: Sequence[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for stem in stems:
        if stem in _FREQ_RESERVATIONS:
            out[stem] = _FREQ_RESERVATIONS[stem]
        elif "vocal" in stem:
            out[stem] = _FREQ_RESERVATIONS["lead_vocal"]
        elif "kick" in stem or stem == "drums":
            out["kick"] = _FREQ_RESERVATIONS["kick"]
        elif "synth" in stem:
            out[stem] = _FREQ_RESERVATIONS["synth_lead"]
    return out


def _mix_intents_from_vector(vector: Mapping[str, float]) -> MixIntents:
    aggression = clamp01(vector.get("spectral_aggression", 0.5))
    depth = clamp01(vector.get("spatial_depth", 0.5))
    headroom = clamp01(vector.get("dynamic_headroom", 0.5))
    return MixIntents(
        sidechain_kick_bass=round(0.25 + 0.45 * aggression, 3),
        vocal_pocket_db=round(1.0 + 2.0 * (1.0 - headroom), 3),
        shared_reverb_bus=round(0.10 + 0.20 * depth, 3),
        frequency_mask_mid_db=3.0,
    )


def _title_from_prompt(prompt: str | None) -> str:
    text = " ".join(str(prompt or "").strip().split())
    if not text:
        return "Untitled Track"
    return text[:72]


def build_song_plan(
    prompt: str,
    genre_hint: str | None = None,
    *,
    seed: int = 0,
    request_id: str = "",
    bpm: float | int | None = None,
    key: str | None = None,
    scale: str | None = None,
    title: str | None = None,
    arrangement_sections: Sequence[Mapping[str, Any]] | None = None,
    total_bars: int | None = None,
    master_lufs_target: float = -14.0,
    true_peak_limit: float = -1.0,
) -> GlobalSongPlan:
    """Build an immutable ``GlobalSongPlan`` before any stem query.

    When ``arrangement_sections`` is provided (from ``arrangement_brain`` /
    the local conductor), bar lengths and energies are taken from that map so
    the assembler math stays aligned. Otherwise a default IVBD skeleton is used.
    """
    blended, sources = resolve_genre_vector(prompt, genre_hint)
    genre_blend = GenreVector(**{axis: blended[axis] for axis in VECTOR_AXES})
    nudges = arrangement_nudges_from_vector(blended)
    mix_intents = _mix_intents_from_vector(blended)

    # Genre-aware default when the user did not lock a key (avoids universal E minor).
    if not key:
        from engine.genre_key_defaults import resolve_genre_default_key

        key = resolve_genre_default_key(genre_hint, prompt, seed=seed)

    root, scale_mode = parse_key_scale(key)
    if scale:
        scale_mode = str(scale).strip().lower() or scale_mode
    # Also accept combined "E_minor" in the key field alone.
    if key and ("_" in str(key) or " " in str(key)):
        root, scale_mode = parse_key_scale(key, default_key=root, default_scale=scale_mode)

    bpm_i = int(round(float(bpm if bpm is not None else 120)))
    bpm_i = max(40, min(240, bpm_i))
    density = chord_density_for_song(
        genre_hint, prompt, float(genre_blend.harmonic_complexity)
    )
    from engine.genre_arrangement_profiles import resolve_genre_grammar

    grammar = resolve_genre_grammar(genre_hint or prompt)
    print(
        f"[GRAMMAR] {genre_hint or prompt or 'unknown'} -> {grammar.archetype} "
        f"chords={','.join(grammar.allowed_chords)} "
        f"vocal={grammar.vocal_phrase_bars}/{grammar.vocal_rest_bars} "
        f"bass={grammar.bass_behavior}",
        flush=True,
    )
    romans = _progression_for(scale_mode, density)

    sections_out: list[SectionPlan] = []
    roadmap: list[dict[str, Any]] = []
    cursor = 0

    from engine.conductor_matrix import apply_dsp_rules, filter_stems_for_rules
    from engine.hybrid_conductor import AdaptiveConductor

    planned_default = 44
    if arrangement_sections:
        planned_default = sum(
            max(1, int(raw.get("bars") or raw.get("slice_count") or 4))
            for raw in arrangement_sections
        )
    else:
        planned_default = 44
    conductor = AdaptiveConductor(
        int(total_bars) if total_bars and int(total_bars) > 0 else planned_default,
        str(genre_hint or ""),
    )
    bar_arc = conductor.generate_tension_map()

    if arrangement_sections:
        for raw in arrangement_sections:
            role = normalise_section_role(raw.get("role") or raw.get("name") or "verse")
            name = str(raw.get("name") or role)
            bars = max(1, int(raw.get("bars") or raw.get("slice_count") or 4))
            if raw.get("energy") is None and raw.get("energy_level") is None:
                slice_arc = bar_arc[cursor : cursor + bars]
                energy = conductor.tension_to_unit(
                    float(np.mean(slice_arc)) if slice_arc.size else 50.0
                )
            else:
                energy = clamp01(float(raw.get("energy") or raw.get("energy_level") or 0.5))
            activation = raw.get("bus_activation") if isinstance(raw.get("bus_activation"), dict) else None
            section_romans = role_progression(scale_mode, role, density)
            chords = _chords_for_romans(root, scale_mode, section_romans, density, grammar)
            per_chord = bars_per_chord_for(bars)
            # Cycle chords across bars for the harmonic roadmap.
            for offset in range(bars):
                step = (offset // per_chord) % len(chords)
                roadmap.append(
                    {
                        "bar": cursor + offset,
                        "roman": section_romans[step],
                        "chord": chords[step],
                        "density": round(density, 3),
                        "section": name,
                    }
                )
            stems = filter_stems_for_rules(
                _active_stems_for(role, energy, activation),
                conductor.evaluate_dsp_rules(float(energy) * 100.0),
            )
            sections_out.append(
                SectionPlan(
                    name=name,
                    start_bar=cursor,
                    bars=bars,
                    energy_level=round(energy, 3),
                    chord_progression=chords,
                    active_stems=stems,
                    frequency_reservations=_frequency_reservations_for(stems),
                    bars_per_chord=per_chord,
                )
            )
            cursor += bars
    else:
        default_skeleton = [
            ("intro", 4, 0.25),
            ("verse_1", 8, 0.45),
            ("chorus_1", 8, 0.90),
            ("verse_2", 8, 0.50),
            ("chorus_2", 8, 0.95),
            ("bridge", 4, 0.55),
            ("outro", 4, 0.30),
        ]
        for name, bars, _legacy_energy in default_skeleton:
            role = normalise_section_role(name)
            slice_arc = bar_arc[cursor : cursor + bars]
            energy_10 = float(np.mean(slice_arc)) if slice_arc.size else 50.0
            energy = conductor.tension_to_unit(energy_10)
            chords = _chords_for_romans(root, scale_mode, romans, density, grammar)
            for offset in range(bars):
                roman = romans[offset % len(romans)]
                roadmap.append(
                    {
                        "bar": cursor + offset,
                        "roman": roman,
                        "chord": chords[offset % len(chords)],
                        "density": round(density, 3),
                        "section": name,
                    }
                )
            stems = filter_stems_for_rules(
                _active_stems_for(role, energy),
                conductor.evaluate_dsp_rules(energy_10),
            )
            sections_out.append(
                SectionPlan(
                    name=name,
                    start_bar=cursor,
                    bars=bars,
                    energy_level=round(energy, 3),
                    chord_progression=chords,
                    active_stems=stems,
                    frequency_reservations=_frequency_reservations_for(stems),
                )
            )
            cursor += bars

    total = int(total_bars) if total_bars is not None else cursor
    if total < cursor:
        total = cursor

    structural = [s.name for s in sections_out]
    energy_arc = [
        {
            "section": s.name,
            "energy": s.energy_level,
            "energy_10": round(float(s.energy_level) * 10.0, 2),
            "tension": round(float(s.energy_level) * 100.0, 2),
            "dsp": apply_dsp_rules(float(s.energy_level) * 100.0),
        }
        for s in sections_out
    ]
    core_metadata = {
        "bpm": bpm_i,
        "key": f"{root}_{scale_mode}",
        "time_signature": "4/4",
        "genre": str(genre_hint or ""),
        "genre_hint": str(genre_hint or ""),
    }

    return GlobalSongPlan(
        title=title or _title_from_prompt(prompt),
        key=root,
        scale=scale_mode,
        bpm=bpm_i,
        time_signature="4/4",
        total_bars=total,
        genre_blend=genre_blend,
        sections=sections_out,
        master_lufs_target=float(master_lufs_target),
        true_peak_limit=float(true_peak_limit),
        seed=int(seed),
        request_id=str(request_id or ""),
        source_genres=sources,
        mix_intents=mix_intents,
        core_metadata=core_metadata,
        structural_array=structural,
        energy_arc=energy_arc,
        harmonic_roadmap=roadmap,
        arrangement_nudges=nudges,
    )


def song_plan_to_dict(plan: GlobalSongPlan) -> dict[str, Any]:
    """JSON-ready dict (Pydantic v2 ``model_dump``)."""
    return plan.model_dump(mode="python")


def song_plan_from_dict(data: Mapping[str, Any]) -> GlobalSongPlan:
    return GlobalSongPlan.model_validate(dict(data))


def section_retrieval_constraints(section: SectionPlan, plan: GlobalSongPlan) -> dict[str, Any]:
    """Parameters the stem selector / generator must honour for one section."""
    root_chord = section.chord_progression[0] if section.chord_progression else plan.key
    return {
        "bpm": plan.bpm,
        "key": plan.key,
        "scale": plan.scale,
        "root_chord": root_chord,
        "chord_progression": list(section.chord_progression),
        "energy_level": section.energy_level,
        "active_stems": list(section.active_stems),
        "start_bar": section.start_bar,
        "bars": section.bars,
        "section_name": section.name,
        "frequency_reservations": dict(section.frequency_reservations),
        "genre_blend": plan.genre_blend.model_dump(),
        "mix_intents": plan.mix_intents.model_dump(),
    }


# Back-compat aliases used by earlier Module 1 notes.
GenreFeatureVector = GenreVector
