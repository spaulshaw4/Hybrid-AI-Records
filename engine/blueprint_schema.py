"""Arrangement blueprint contract: TypedDicts, JSON Schema, and normalizer.

The chorus/intro example in the spec has two sections. Structural validation
allows 1–16 sections so that example can be checked. Gemini/heuristic output is
padded or trimmed to 5–8 sections by ``normalize_blueprint``.
"""
from __future__ import annotations

from typing import Any, TypedDict

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLAT_ALIASES = {
    "DB": "C#",
    "EB": "D#",
    "GB": "F#",
    "AB": "G#",
    "BB": "A#",
    "CB": "B",
    "FB": "E",
    "E#": "F",
    "B#": "C",
}
LAYER_KEYS = ("rhythm", "harmonic", "lead", "vocal")
MIN_BPM = 60
MAX_BPM = 180
ARRANGE_MIN_SECTIONS = 5
ARRANGE_MAX_SECTIONS = 8

BLUEPRINT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "HybridArrangementBlueprint",
    "type": "object",
    "required": ["track_metadata", "sections"],
    "properties": {
        "track_metadata": {
            "type": "object",
            "required": ["title", "bpm", "root_key", "genre", "total_bars"],
            "properties": {
                "title": {"type": "string", "minLength": 1},
                "bpm": {"type": "number", "minimum": MIN_BPM, "maximum": MAX_BPM},
                "root_key": {"type": "string"},
                "genre": {"type": "string", "minLength": 1},
                "total_bars": {"type": "integer", "minimum": 1},
            },
            "additionalProperties": True,
        },
        "sections": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "items": {
                "type": "object",
                "required": ["name", "slice_count", "energy", "volume_weights"],
                "properties": {
                    "name": {"type": "string", "minLength": 1},
                    "slice_count": {"type": "integer", "minimum": 1},
                    "energy": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "volume_weights": {
                        "type": "object",
                        "required": list(LAYER_KEYS),
                        "properties": {
                            "rhythm": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                            "harmonic": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                            "lead": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                            "vocal": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                        },
                    },
                    "query_tags": {
                        "type": "object",
                        "properties": {
                            "rhythm": {"type": "array", "items": {"type": "string"}},
                            "harmonic": {"type": "array", "items": {"type": "string"}},
                            "lead": {"type": "array", "items": {"type": "string"}},
                            "vocal": {"type": "array", "items": {"type": "string"}},
                        },
                    },
                    "dsp_filters": {
                        "type": "object",
                        "properties": {
                            "lowpass_hz": {"type": "number"},
                            "reverb_send": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                            "saturation_drive": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                        },
                    },
                },
            },
        },
    },
}

# User-spec intro/chorus example — used by unit tests.
SAMPLE_BLUEPRINT: dict[str, Any] = {
    "track_metadata": {
        "title": "Generated_Track_01",
        "bpm": 138,
        "root_key": "D#",
        "genre": "dark_electronic_rock",
        "total_bars": 32,
    },
    "sections": [
        {
            "name": "intro",
            "slice_count": 4,
            "energy": 0.35,
            "volume_weights": {
                "rhythm": 0.40,
                "harmonic": 0.70,
                "lead": 0.20,
                "vocal": 0.00,
            },
            "query_tags": {
                "rhythm": ["sub_kick", "sparse_hat"],
                "harmonic": ["dark_pad", "drone"],
                "lead": ["ambient_pluck"],
                "vocal": [],
            },
            "dsp_filters": {
                "lowpass_hz": 3200,
                "reverb_send": 0.45,
                "saturation_drive": 0.10,
            },
        },
        {
            "name": "chorus",
            "slice_count": 8,
            "energy": 0.95,
            "volume_weights": {
                "rhythm": 0.90,
                "harmonic": 0.75,
                "lead": 0.85,
                "vocal": 0.60,
            },
            "query_tags": {
                "rhythm": ["heavy_drums", "punchy_snare"],
                "harmonic": ["distorted_bass", "wall_synth"],
                "lead": ["screaming_guitar", "octave_lead"],
                "vocal": ["vocal_chop_energetic"],
            },
            "dsp_filters": {
                "lowpass_hz": 20000,
                "reverb_send": 0.15,
                "saturation_drive": 0.45,
            },
        },
    ],
}


class VolumeWeights(TypedDict):
    rhythm: float
    harmonic: float
    lead: float
    vocal: float


class QueryTags(TypedDict):
    rhythm: list[str]
    harmonic: list[str]
    lead: list[str]
    vocal: list[str]


class DspFilters(TypedDict):
    lowpass_hz: float
    reverb_send: float
    saturation_drive: float


class SectionBlueprint(TypedDict):
    name: str
    slice_count: int
    energy: float
    volume_weights: VolumeWeights
    query_tags: QueryTags
    dsp_filters: DspFilters


class TrackMetadata(TypedDict):
    title: str
    bpm: float
    root_key: str
    genre: str
    total_bars: int


class ArrangementBlueprint(TypedDict):
    track_metadata: TrackMetadata
    sections: list[SectionBlueprint]


class BlueprintValidationError(ValueError):
    """Raised when a blueprint cannot be normalized to the contract."""


def strip_json_fences(text: str) -> str:
    """Remove accidental markdown fences and isolate the first JSON object."""
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1]
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.rsplit("```", 1)[0].strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise BlueprintValidationError("response contained no JSON object")
    return cleaned[start : end + 1]


def normalise_root_key(note: str) -> str:
    token = str(note or "A").strip()
    token = token.replace("♭", "B").replace("♯", "#")
    parts = token.replace("-", " ").replace("_", " ").split()
    root = parts[0] if parts else "A"
    root = root.upper()
    if len(root) > 1 and root.endswith("B") and root not in NOTE_NAMES:
        root = root[:-1] + "B"
    root = _FLAT_ALIASES.get(root, root)
    if root not in NOTE_NAMES:
        raise BlueprintValidationError(f"Unknown root note: {note}")
    return root


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(value)))


def _as_float(value: Any, default: float) -> float:
    try:
        if value is None or value == "":
            return float(default)
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _as_int(value: Any, default: int) -> int:
    try:
        if value is None or value == "":
            return int(default)
        return int(round(float(value)))
    except (TypeError, ValueError):
        return int(default)


def _weight_map(raw: Any) -> VolumeWeights:
    src = raw if isinstance(raw, dict) else {}
    if not src and isinstance(raw, dict):
        src = raw
    return {
        "rhythm": _clamp(_as_float(src.get("rhythm"), 0.0), 0.0, 1.0),
        "harmonic": _clamp(_as_float(src.get("harmonic"), 0.0), 0.0, 1.0),
        "lead": _clamp(_as_float(src.get("lead"), 0.0), 0.0, 1.0),
        "vocal": _clamp(_as_float(src.get("vocal"), 0.0), 0.0, 1.0),
    }


def _tag_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
        return parts
    if isinstance(raw, (list, tuple)):
        return [str(item).strip() for item in raw if str(item).strip()]
    return []


def _query_tags(raw: Any) -> QueryTags:
    src = raw if isinstance(raw, dict) else {}
    return {
        "rhythm": _tag_list(src.get("rhythm")),
        "harmonic": _tag_list(src.get("harmonic")),
        "lead": _tag_list(src.get("lead")),
        "vocal": _tag_list(src.get("vocal")),
    }


def _dsp_filters(raw: Any) -> DspFilters:
    src = raw if isinstance(raw, dict) else {}
    return {
        "lowpass_hz": max(80.0, _as_float(src.get("lowpass_hz"), 20000.0)),
        "reverb_send": _clamp(_as_float(src.get("reverb_send"), 0.20), 0.0, 1.0),
        "saturation_drive": _clamp(_as_float(src.get("saturation_drive"), 0.10), 0.0, 1.0),
    }


ARRANGE_BUSES = ("rhythm", "bass", "harmonic", "vocal")


def _bus_activation(raw: Any) -> dict[str, float] | None:
    """Per-bus section gains written by ``engine.arrangement_brain``."""
    if not isinstance(raw, dict) or not raw:
        return None
    return {
        bus: _clamp(_as_float(raw.get(bus), 0.0), 0.0, 1.0) for bus in ARRANGE_BUSES
    }


def _bus_variant(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict) or not raw:
        return None
    return {bus: max(0, _as_int(raw.get(bus), 0)) for bus in ARRANGE_BUSES}


def _section(raw: Any, fallback_name: str) -> SectionBlueprint:
    src = raw if isinstance(raw, dict) else {}
    name = str(src.get("name") or fallback_name).strip() or fallback_name
    weights = _weight_map(src.get("volume_weights") or src.get("layers"))
    raw_weights = src.get("volume_weights") or src.get("layers")
    if isinstance(raw_weights, dict) and raw_weights.get("bass") is not None:
        weights["bass"] = _clamp(_as_float(raw_weights.get("bass"), 0.0), 0.0, 1.0)
    section: dict[str, Any] = {
        "name": name,
        "slice_count": max(1, _as_int(src.get("slice_count"), 4)),
        "energy": _clamp(_as_float(src.get("energy"), 0.5), 0.0, 1.0),
        "volume_weights": weights,
        "query_tags": _query_tags(src.get("query_tags")),
        "dsp_filters": _dsp_filters(src.get("dsp_filters")),
    }
    # Arrangement-brain fields survive normalization so the assembler can read
    # a real section map instead of falling back to one loop for the whole track.
    activation = _bus_activation(src.get("bus_activation"))
    if activation is not None:
        section["bus_activation"] = activation
    variant = _bus_variant(src.get("bus_variant"))
    if variant is not None:
        section["bus_variant"] = variant
    if src.get("bars") is not None:
        section["bars"] = max(1, _as_int(src.get("bars"), 4))
    if src.get("role"):
        section["role"] = str(src["role"])
    fills = src.get("fill_bars")
    if isinstance(fills, (list, tuple)):
        section["fill_bars"] = sorted({max(0, _as_int(b, 0)) for b in fills})
    return section  # type: ignore[return-value]


def _pad_sections(sections: list[SectionBlueprint]) -> list[SectionBlueprint]:
    extras = (
        ("bridge", 4, 0.45, (0.55, 0.60, 0.35, 0.15)),
        ("drop", 6, 0.90, (0.88, 0.70, 0.80, 0.40)),
        ("verse_2", 6, 0.60, (0.70, 0.65, 0.40, 0.25)),
        ("outro", 4, 0.30, (0.50, 0.45, 0.20, 0.00)),
    )
    out = list(sections)
    idx = 0
    while len(out) < ARRANGE_MIN_SECTIONS:
        name, count, energy, weights = extras[idx % len(extras)]
        out.append(
            {
                "name": name,
                "slice_count": count,
                "energy": energy,
                "volume_weights": {
                    "rhythm": weights[0],
                    "harmonic": weights[1],
                    "lead": weights[2],
                    "vocal": weights[3],
                },
                "query_tags": {
                    "rhythm": ["drums", "rhythm"],
                    "harmonic": ["pad", "harmonic"],
                    "lead": ["lead"],
                    "vocal": [],
                },
                "dsp_filters": _dsp_filters(None),
            }
        )
        idx += 1
    return out[:ARRANGE_MAX_SECTIONS]


def validate_blueprint(
    data: Any,
    *,
    enforce_section_span: bool = False,
) -> ArrangementBlueprint:
    """Normalize ``data`` to the contract. Structural check, not a live model call."""
    if not isinstance(data, dict):
        raise BlueprintValidationError("blueprint must be a JSON object")
    meta_src = data.get("track_metadata") or data.get("metadata") or {}
    if not isinstance(meta_src, dict):
        meta_src = {}
    raw_sections = data.get("sections")
    if not isinstance(raw_sections, list) or not raw_sections:
        raise BlueprintValidationError("blueprint contains no sections")

    sections = [_section(item, f"section_{i + 1}") for i, item in enumerate(raw_sections)]
    if enforce_section_span:
        if len(sections) < ARRANGE_MIN_SECTIONS:
            sections = _pad_sections(sections)
        sections = sections[:ARRANGE_MAX_SECTIONS]
        if not (ARRANGE_MIN_SECTIONS <= len(sections) <= ARRANGE_MAX_SECTIONS):
            raise BlueprintValidationError("section count must be 5–8 after normalize")

    bpm = _clamp(_as_float(meta_src.get("bpm") or data.get("bpm"), 120.0), MIN_BPM, MAX_BPM)
    root = normalise_root_key(str(meta_src.get("root_key") or data.get("root_key") or "A"))
    title = str(meta_src.get("title") or data.get("title") or "Generated_Track_01").strip()
    genre = str(meta_src.get("genre") or data.get("genre") or "alt_rock").strip() or "alt_rock"
    total_bars = _as_int(meta_src.get("total_bars"), 0)
    if total_bars < 1:
        total_bars = sum(sec["slice_count"] for sec in sections)

    blueprint: ArrangementBlueprint = {
        "track_metadata": {
            "title": title or "Generated_Track_01",
            "bpm": float(int(round(bpm))),
            "root_key": root,
            "genre": genre,
            "total_bars": int(total_bars),
        },
        "sections": sections,
    }
    if isinstance(data.get("arrangement"), dict):
        blueprint["arrangement"] = dict(data["arrangement"])  # type: ignore[typeddict-unknown-key]
    return blueprint


def validate_sample_contract(data: Any = None) -> ArrangementBlueprint:
    """Validate the user intro/chorus example (2 sections allowed)."""
    return validate_blueprint(data if data is not None else SAMPLE_BLUEPRINT, enforce_section_span=False)
