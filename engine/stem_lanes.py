"""13-lane arrangement console.

Every stem is locked to one lane. A vocal cannot sit on a drum lane, a strum
cannot sit on the kick, and a lead fill is only scheduled inside the vocal
rest window. The timeline is written before the mix renders.
"""
from __future__ import annotations

import json
import os
from typing import Any, Mapping, Sequence

# Lane id, name, frequency box, stereo image, and the rule that schedules it.
LANES: tuple[dict[str, Any], ...] = (
    {"id": "01_kick", "name": "Kick / Sub-Pulse", "hz": (20, 120), "stereo": "mono",
     "rule": "locks_tempo_grid_and_sidechains_sub"},
    {"id": "02_snare", "name": "Snare / Backbeat", "hz": (150, 5000), "stereo": "center",
     "rule": "backbeat_anchor"},
    {"id": "03_tops", "name": "Tops & Shakers", "hz": (4000, 18000), "stereo": "wide",
     "rule": "subdivision_carrier"},
    {"id": "04_aux_perc", "name": "Aux Percussion", "hz": (200, 8000), "stereo": "mid_side",
     "rule": "drops_in_sparse_sections"},
    {"id": "05_sub_bass", "name": "Sub Bass / 808", "hz": (25, 90), "stereo": "mono",
     "rule": "ducked_by_kick_tracks_root"},
    {"id": "06_mid_bass", "name": "Mid Bass / Body", "hz": (90, 350), "stereo": "narrow",
     "rule": "follows_chord_roots"},
    {"id": "07_primary_comp", "name": "Primary Comp", "hz": (200, 4000), "stereo": "mid",
     "rule": "ducks_3db_when_vocal_active"},
    {"id": "08_harmonic_bed", "name": "Harmonic Bed / Pad", "hz": (300, 6000), "stereo": "wide",
     "rule": "sustained_lowest_transient_priority"},
    {"id": "09_secondary_comp", "name": "Secondary Comp", "hz": (400, 5000), "stereo": "panned",
     "rule": "pocket_left_by_primary_comp"},
    {"id": "10_lead_inst", "name": "Lead Instrument", "hz": (500, 7000), "stereo": "center",
     "rule": "fill_window_minus_12db_under_vocal"},
    {"id": "11_lead_vocal", "name": "Primary Lead Vocal", "hz": (120, 8000), "stereo": "center",
     "rule": "midrange_priority_and_phrase_duty"},
    {"id": "12_vocal_backing", "name": "Vocal Backing / Choirs", "hz": (250, 10000), "stereo": "wide",
     "rule": "cadence_hook_or_rest_only"},
    {"id": "13_transitions_fx", "name": "Transitions & FX", "hz": (20, 20000), "stereo": "full",
     "rule": "boundary_bars_8_16_24"},
)

LANE_IDS: tuple[str, ...] = tuple(str(lane["id"]) for lane in LANES)
TRACK_ORDER: tuple[str, ...] = LANE_IDS

# Coarse assembler buses. The comp bus is stored as "harmonic".
_GROUP = {
    "01_kick": "drums", "02_snare": "drums", "03_tops": "drums", "04_aux_perc": "drums",
    "05_sub_bass": "bass", "06_mid_bass": "bass",
    "07_primary_comp": "comp", "08_harmonic_bed": "comp", "09_secondary_comp": "comp",
    "10_lead_inst": "lead",
    "11_lead_vocal": "vocal", "12_vocal_backing": "vocal",
    "13_transitions_fx": "fx",
}
GROUPS = {
    "drums": {"01_kick", "02_snare", "03_tops", "04_aux_perc"},
    "bass": {"05_sub_bass", "06_mid_bass"},
    "comp": {"07_primary_comp", "08_harmonic_bed", "09_secondary_comp"},
    "lead": {"10_lead_inst"},
    "vocal": {"11_lead_vocal", "12_vocal_backing"},
    "fx": {"13_transitions_fx"},
}
_GROUP_ALIAS = {"rhythm": "comp", "harmonic": "comp", "rhythm_comp": "comp", "drums": "drums"}
_GROUP_DEFAULT = {
    "drums": "01_kick",
    "bass": "06_mid_bass",
    "comp": "07_primary_comp",
    "lead": "10_lead_inst",
    "vocal": "11_lead_vocal",
    "fx": "13_transitions_fx",
}

BUS_TO_LANE = {
    "rhythm": "drums",
    "drums": "drums",
    "bass": "bass",
    "harmonic": "comp",
    "rhythm_comp": "comp",
    "lead": "lead",
    "vocal": "vocal",
}

_CLOCK = {"01_kick", "02_snare"}
_ROOT = {"05_sub_bass", "06_mid_bass"}
_HARMONY = {
    "07_primary_comp", "08_harmonic_bed", "09_secondary_comp",
    "10_lead_inst", "11_lead_vocal", "12_vocal_backing", "13_transitions_fx",
}

DEFAULT_GAIN_DB = {
    "01_kick": 0.0,
    "02_snare": 0.0,
    "03_tops": -2.0,
    "04_aux_perc": -4.5,
    "05_sub_bass": -1.0,
    "06_mid_bass": -2.5,
    "07_primary_comp": 0.0,
    "08_harmonic_bed": -6.0,
    "09_secondary_comp": -5.0,
    "10_lead_inst": -1.5,
    "11_lead_vocal": 0.0,
    "12_vocal_backing": -3.5,
    "13_transitions_fx": -2.0,
}

COMP_DUCK_DB = -3.0
LEAD_OVERLAP_DB = -12.0
LEAD_OVERLAP_GAIN = 10.0 ** (LEAD_OVERLAP_DB / 20.0)
COMP_DUCK_GAIN = 10.0 ** (COMP_DUCK_DB / 20.0)
KICK_SIDECHAIN_DB = -3.0

_DIATONIC = {0, 2, 3, 4, 5, 7, 8, 9, 10}
_CLASH = {1, 6}
_STAGE_PREFIXES = ("harmonic_", "rhythm_", "drums_", "vocal_", "bass_", "lead_", "fx_")
_SPARSE_NAMES = ("breakdown", "intro", "outro", "ambient")

_FX = {"fx", "riser", "riser", "downlifter", "impact", "reverse", "transition", "whoosh", "sweep"}
_BACKING = {"backing", "choir", "choirs", "adlib", "adlibs", "double", "doubles", "bgv", "harmony", "harmonies"}
_VOCAL = {"vocal", "vocals", "vox", "vx", "topline", "sing"}
_LEAD = {"lead", "solo", "lick", "twang", "riff", "hook"}
_SECONDARY = {"rhodes", "organ", "skank", "chop", "chops", "wurlitzer", "clav"}
_BED = {"pad", "pads", "string", "strings", "cello", "cellos", "violin", "drone", "wash", "bed"}
_COMP = {"strum", "acoustic", "boomchick", "comp", "piano", "guitar", "keys"}
_SUB = {"sub", "subbass", "808"}
_BASS = {"bass", "slap", "finger", "tele"}
_TOPS = {"hat", "hats", "hihat", "shaker", "shakers", "ride"}
_AUX = {"perc", "percussion", "aux", "conga", "bongo", "rimshot", "foley", "clave", "cowbell", "tambourine"}
_SNARE = {"snare", "backbeat", "clap", "claps"}
_KICK = {"kick", "kicks"}
_DRUMS = {"drum", "drums", "kit", "groove", "pocket"}


def _tokens(name: str) -> list[str]:
    cleaned: list[str] = []
    word: list[str] = []
    for ch in name.lower():
        if ch.isalnum():
            word.append(ch)
        elif word:
            cleaned.append("".join(word))
            word = []
    if word:
        cleaned.append("".join(word))
    return cleaned


def strip_stage_prefix(name: str) -> str:
    base = os.path.basename(name)
    lowered = base.lower()
    for prefix in _STAGE_PREFIXES:
        if lowered.startswith(prefix):
            return base[len(prefix):]
    return base


def stem_id_of(path: str) -> str:
    base = strip_stage_prefix(path)
    return os.path.splitext(base)[0]


def classify_lane(path: str) -> str | None:
    """The single lane this file is allowed to occupy."""
    tokens = set(_tokens(strip_stage_prefix(path)))
    if not tokens:
        return None
    if tokens & _FX:
        return "13_transitions_fx"
    vocalish = bool(tokens & _VOCAL)
    if vocalish and tokens & _BACKING:
        return "12_vocal_backing"
    if tokens & {"choir", "choirs", "adlib", "adlibs", "bgv", "backing"}:
        return "12_vocal_backing"
    if vocalish:
        return "11_lead_vocal"
    if tokens & _LEAD:
        return "10_lead_inst"
    if tokens & _SECONDARY:
        return "09_secondary_comp"
    if tokens & _BED or (tokens & {"harmony", "harmonies"} and not vocalish):
        return "08_harmonic_bed"
    if tokens & _COMP:
        return "07_primary_comp"
    if "808" in tokens and tokens & _KICK:
        return "01_kick"
    if tokens & _SUB or "808" in tokens:
        return "05_sub_bass"
    if tokens & _BASS:
        return "06_mid_bass"
    if tokens & _TOPS:
        return "03_tops"
    if tokens & _AUX:
        return "04_aux_perc"
    if tokens & _SNARE:
        return "02_snare"
    if tokens & _KICK:
        return "01_kick"
    if tokens & _DRUMS:
        return "01_kick"
    return None


def staged_group(path: str) -> str | None:
    base = os.path.basename(path).lower()
    for prefix, group in (
        ("vocal_", "vocal"),
        ("bass_", "bass"),
        ("lead_", "lead"),
        ("fx_", "fx"),
        ("drums_", "drums"),
        ("rhythm_", "drums"),
        ("harmonic_", "comp"),
    ):
        if base.startswith(prefix):
            return group
    return None


def _wanted_group(lane: str) -> str | None:
    if lane in _GROUP:
        return _GROUP[lane]
    alias = _GROUP_ALIAS.get(lane, lane)
    if alias in GROUPS:
        return alias
    mapped = BUS_TO_LANE.get(lane)
    if mapped in GROUPS:
        return mapped
    return None


def path_fits_lane(lane: str, path: str) -> bool:
    """False when this file is locked to a different acoustic lane."""
    content = classify_lane(path)
    staged = staged_group(path)
    if lane in _GROUP:
        if content != lane:
            return False
        if staged is not None and staged != _GROUP[lane]:
            return False
        return True
    group = _wanted_group(lane)
    if group is None:
        return False
    if content is not None and _GROUP[content] != group:
        return False
    if staged is not None and staged != group:
        return False
    if content is None and staged is None:
        return group == "comp"
    return True


def filter_lane(lane: str, paths: Sequence[str]) -> list[str]:
    return [path for path in paths if path_fits_lane(lane, path)]


def assign_lanes(paths: Sequence[str]) -> dict[str, list[str]]:
    """One file, one lane. Later copies of the same lane stay as alternates."""
    assigned: dict[str, list[str]] = {lane: [] for lane in LANE_IDS}
    for path in paths:
        if not path:
            continue
        lane = classify_lane(path)
        if lane is None:
            group = staged_group(path)
            lane = _GROUP_DEFAULT.get(group or "")
        if lane is None or path in assigned[lane]:
            continue
        assigned[lane].append(path)
    return assigned


def duty_mask(bars: int, phrase_bars: int, rest_bars: int) -> list[int]:
    """1 where the lead vocal may sing, 0 where the band breathes."""
    total = max(0, int(bars))
    if total == 0:
        return []
    phrase = max(1, int(phrase_bars))
    rest = int(rest_bars)
    if rest <= 0:
        return [1] * total
    mask: list[int] = []
    playing = True
    while len(mask) < total:
        span = min(phrase if playing else rest, total - len(mask))
        mask.extend([1 if playing else 0] * span)
        playing = not playing
    return mask


def _bars_where(mask: Sequence[int], flag: int) -> list[int]:
    return [index + 1 for index, bit in enumerate(mask) if int(bit) == flag]


def _span(bars: Sequence[int]) -> list[int]:
    if not bars:
        return []
    return [int(bars[0]), int(bars[-1])]


def _runs(bars: Sequence[int]) -> list[list[int]]:
    runs: list[list[int]] = []
    current: list[int] = []
    previous = 0
    for bar in bars:
        if current and int(bar) != previous + 1:
            runs.append(current)
            current = []
        current.append(int(bar))
        previous = int(bar)
    if current:
        runs.append(current)
    return runs


def fill_window(bars: int, phrase_bars: int, rest_bars: int) -> list[int]:
    """Last two bars of each 8-bar block that the vocal is not singing."""
    mask = duty_mask(bars, phrase_bars, rest_bars)
    resting = set(_bars_where(mask, 0))
    chosen: list[int] = []
    for block in range(0, max(0, int(bars)), 8):
        end = min(int(bars), block + 8)
        for bar in range(max(block + 1, end - 1), end + 1):
            if bar in resting:
                chosen.append(bar)
    return chosen


def cadence_bars(mask: Sequence[int]) -> list[int]:
    """Last two bars of the first sung phrase."""
    runs = _runs(_bars_where(mask, 1))
    if not runs:
        return []
    return runs[0][-2:]


def boundary_bars(start_bar: int, bars: int) -> list[int]:
    """Section-local bars whose song bar is 8, 16, 24, ..."""
    found: list[int] = []
    for offset in range(max(0, int(bars))):
        song_bar = int(start_bar) + offset + 1
        if song_bar % 8 == 0:
            found.append(offset + 1)
    return found[-1:] if found else []


def interval_score(bass_pc: int, chord_pcs: Sequence[int], *, allow_clash: bool = False) -> float:
    """1.0 when every chord tone is a diatonic interval from the bass root."""
    if not chord_pcs:
        return 0.0
    intervals = {((int(pc) - int(bass_pc)) % 12) for pc in chord_pcs}
    if not allow_clash and intervals & _CLASH:
        return 0.0
    if intervals <= _DIATONIC or allow_clash:
        return 1.0
    return 0.0


def _chord_pcs(symbol: str) -> tuple[int, set[int]]:
    text = str(symbol or "").strip()
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    if not text or text[0].upper() not in names:
        return 0, set()
    root = names[text[0].upper()]
    index = 1
    if len(text) > 1 and text[1] in "#b":
        root = (root + (1 if text[1] == "#" else -1)) % 12
        index = 2
    quality = text[index:].lower()
    tones = {0, 4, 7}
    if quality.startswith("m") and not quality.startswith("maj"):
        tones = {0, 3, 7}
    if quality in {"5"} or (quality.endswith("5") and not quality.endswith("b5")):
        tones = {0, 7}
    if "sus2" in quality:
        tones = {0, 2, 7}
    elif "sus4" in quality:
        tones = {0, 5, 7}
    if "7" in quality and "maj" not in quality:
        tones = set(tones) | {10}
    if "maj7" in quality:
        tones = {0, 4, 7, 11}
    return root, {(root + tone) % 12 for tone in tones}


def _slot(
    lane: str,
    files: Sequence[str],
    active: Sequence[int],
    *,
    gain_db: float | None = None,
    reason: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    chosen = stem_id_of(files[0]) if files else None
    if reason and not chosen:
        entry: dict[str, Any] = {
            "stem_id": None,
            "gain_db": 0.0,
            "active_bars": [],
            "reason": reason,
        }
    elif not chosen:
        entry = {"stem_id": None, "gain_db": 0.0, "active_bars": [], "reason": "not_staged"}
    elif not active:
        entry = {
            "stem_id": None,
            "gain_db": 0.0,
            "active_bars": [],
            "reason": reason or "no_window",
        }
    else:
        entry = {
            "stem_id": chosen,
            "gain_db": round(float(DEFAULT_GAIN_DB[lane] if gain_db is None else gain_db), 2),
            "active_bars": _span(active),
        }
        if reason:
            entry["reason"] = reason
    if extra and entry.get("stem_id"):
        entry.update(dict(extra))
    return entry


def _foundation_ready(assigned: Mapping[str, Sequence[str]]) -> bool:
    clock = any(assigned.get(lane) for lane in _CLOCK)
    root = any(assigned.get(lane) for lane in _ROOT)
    return clock and root


def schedule_section(
    section: Mapping[str, Any],
    assigned: Mapping[str, Sequence[str]],
    *,
    phrase_bars: int = 4,
    rest_bars: int = 4,
    comping_style: str | None = None,
    allow_clash: bool = False,
    key_label: str = "C_major",
) -> dict[str, Any]:
    """One section of the 13-lane timeline, before any audio is summed."""
    bars = max(1, int(section.get("bars") or 1))
    start = int(section.get("start_bar") or 0)
    name = str(section.get("name") or section.get("section_id") or "section")
    energy = float(section.get("energy_level") or 0.7)
    sparse = energy < 0.35 or any(token in name.lower() for token in _SPARSE_NAMES)
    mask = duty_mask(bars, phrase_bars, rest_bars)
    sung = _bars_where(mask, 1)
    rests = fill_window(bars, phrase_bars, rest_bars)
    full = list(range(1, bars + 1))
    ready = _foundation_ready(assigned)
    block = None if ready else "foundation_missing"
    bed = full

    vocal_files = list(assigned.get("11_lead_vocal") or [])
    vocal_active = sung if vocal_files and ready else []
    comp_gain = COMP_DUCK_DB if vocal_active else DEFAULT_GAIN_DB["07_primary_comp"]
    tops_gain = DEFAULT_GAIN_DB["03_tops"] if energy >= 0.6 else round(-6.0 + 4.0 * energy, 2)
    lead_files = list(assigned.get("10_lead_inst") or [])
    if not ready:
        lead_active: list[int] = []
        lead_gain = DEFAULT_GAIN_DB["10_lead_inst"]
        lead_reason = block
    elif vocal_files:
        lead_active = list(rests)
        lead_gain = DEFAULT_GAIN_DB["10_lead_inst"]
        lead_reason = None if lead_active else "suppressed_by_vocal_priority"
    else:
        lead_active = full
        lead_gain = DEFAULT_GAIN_DB["10_lead_inst"]
        lead_reason = None
    backing_active = cadence_bars(mask) if vocal_files and ready else []
    backing_reason = None
    if ready and not vocal_files:
        backing_reason = "waits_for_lead_vocal"
    elif ready and vocal_files and not backing_active:
        backing_reason = "no_cadence"
    aux_active = [] if sparse or not ready else list(range(max(1, bars // 2 + 1), bars + 1))
    aux_reason = "sparse_breakdown" if sparse and ready else block
    boundary = boundary_bars(start, bars) if ready else []
    fx_reason = None if boundary else ("not_boundary" if ready else block)

    lanes = {
        "01_kick": _slot("01_kick", assigned.get("01_kick") or [], bed),
        "02_snare": _slot("02_snare", assigned.get("02_snare") or [], bed),
        "03_tops": _slot("03_tops", assigned.get("03_tops") or [], bed, gain_db=tops_gain),
        "04_aux_perc": _slot(
            "04_aux_perc", assigned.get("04_aux_perc") or [], aux_active, reason=aux_reason,
        ),
        "05_sub_bass": _slot(
            "05_sub_bass",
            assigned.get("05_sub_bass") or [],
            full if ready else [],
            reason=block,
            extra={"sidechain_from": "01_kick", "sidechain_db": KICK_SIDECHAIN_DB}
            if ready and assigned.get("01_kick") and assigned.get("05_sub_bass") else None,
        ),
        "06_mid_bass": _slot("06_mid_bass", assigned.get("06_mid_bass") or [], full if ready else [], reason=block),
        "07_primary_comp": _slot(
            "07_primary_comp",
            assigned.get("07_primary_comp") or [],
            full if ready else [],
            gain_db=comp_gain,
            reason=block,
            extra={"pattern": comping_style or "driving_eighths"} if ready else None,
        ),
        "08_harmonic_bed": _slot(
            "08_harmonic_bed", assigned.get("08_harmonic_bed") or [], full if ready else [], reason=block,
        ),
        "09_secondary_comp": _slot(
            "09_secondary_comp",
            assigned.get("09_secondary_comp") or [],
            full if ready else [],
            reason=block,
            extra={"pattern": "syncopated_pocket", "avoids": "07_primary_comp"} if ready else None,
        ),
        "10_lead_inst": _slot(
            "10_lead_inst",
            lead_files,
            lead_active,
            gain_db=lead_gain,
            reason=lead_reason,
        ),
        "11_lead_vocal": _slot(
            "11_lead_vocal",
            vocal_files,
            vocal_active,
            reason=block,
            extra={"duty_mask": list(mask), "rest_bars": _span(rests)} if vocal_files and ready else None,
        ),
        "12_vocal_backing": _slot(
            "12_vocal_backing",
            assigned.get("12_vocal_backing") or [],
            backing_active,
            reason=backing_reason or block,
        ),
        "13_transitions_fx": _slot(
            "13_transitions_fx",
            assigned.get("13_transitions_fx") or [],
            boundary,
            reason=fx_reason,
        ),
    }
    if lead_files and vocal_files and lead_active and set(lead_active) & set(vocal_active):
        lanes["10_lead_inst"]["gain_db"] = LEAD_OVERLAP_DB
        lanes["10_lead_inst"]["reason"] = "ducked_by_vocal_priority"

    chords = [str(chord) for chord in (section.get("chord_progression") or [])]
    scored = []
    for chord in chords:
        root_pc, tones = _chord_pcs(chord)
        score = interval_score(root_pc, tones, allow_clash=allow_clash) if tones else 0.0
        scored.append({
            "chord": chord,
            "score": score,
            "kept": score > 0.0,
            **({} if score > 0.0 else {"reason": "dissonant_against_bass"}),
        })
    return {
        "section_id": name,
        "bars": bars,
        "key": key_label,
        "lanes": lanes,
        "chord_sequence": chords,
        "harmonic_interval": {"allow_clash": bool(allow_clash), "chords": scored},
    }


def _collect_assigned(lane_files: Mapping[str, Sequence[str]]) -> dict[str, list[str]]:
    direct: list[str] = []
    grouped: list[str] = []
    for key, paths in lane_files.items():
        bucket = direct if key in _GROUP else grouped
        for path in paths or []:
            if path:
                bucket.append(str(path))
    assigned = assign_lanes(direct + grouped)
    for key, paths in lane_files.items():
        if key not in _GROUP:
            continue
        for path in paths or []:
            if path and path not in assigned[key]:
                assigned[key].append(str(path))
    return assigned


def build_render_manifest(
    song_id: str,
    *,
    key: str,
    scale: str,
    bpm: float,
    sections: Sequence[Mapping[str, Any]],
    lane_files: Mapping[str, Sequence[str]],
    phrase_bars: int = 4,
    rest_bars: int = 4,
    comping_style: str | None = None,
    allow_clash: bool = False,
    gains_db: Mapping[str, float] | None = None,
) -> dict[str, Any]:
    """Song-level 13-lane timeline. ``gains_db`` is accepted and not applied.

    Lane gains come from the console laws (vocal duck, fill window, sidechain),
    not from the mixer's measured bus trim.
    """
    del gains_db
    key_label = f"{key}_{scale}" if scale and "_" not in str(key) else str(key)
    assigned = _collect_assigned(lane_files)
    body = [
        schedule_section(
            section,
            assigned,
            phrase_bars=phrase_bars,
            rest_bars=rest_bars,
            comping_style=comping_style,
            allow_clash=allow_clash,
            key_label=key_label,
        )
        for section in sections
    ]
    return {
        "song_id": song_id,
        "key": key_label,
        "bpm": float(bpm),
        "console": list(LANE_IDS),
        "laws": [
            "foundation_priority",
            "comping_hierarchy",
            "lead_monophony",
        ],
        "sections": body,
    }


def blank_section_schema(section_id: str = "verse_1", bars: int = 8, key: str = "G_minor") -> dict[str, Any]:
    """Empty contract: thirteen lanes, no stem scheduled."""
    return {
        "section_id": section_id,
        "bars": bars,
        "key": key,
        "lanes": {
            lane: {"stem_id": None, "gain_db": 0.0, "active_bars": []}
            for lane in LANE_IDS
        },
    }


def write_render_manifest(path: str, manifest: Mapping[str, Any]) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    return path
