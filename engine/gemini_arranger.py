"""Prompt → arrangement blueprint. Default is offline heuristic; live is opt-in.

Live backends (never logged): Replicate ``google/gemini-2.5-flash`` via
``REPLICATE_API_TOKEN``, or native Gemini via ``GEMINI_API_KEY`` / ``GOOGLE_API_KEY``.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.blueprint_schema import (  # noqa: E402
    ArrangementBlueprint,
    BlueprintValidationError,
    strip_json_fences,
    validate_blueprint,
)

DEFAULT_OUT = r"D:\MusicDatasets\scratch\gemini_arrangement.json"
REPLICATE_API = "https://api.replicate.com/v1"
DEFAULT_REPLICATE_MODEL = os.environ.get("REPLICATE_GEMINI_MODEL", "google/gemini-2.5-flash").strip()
NATIVE_GEMINI_MODEL = os.environ.get("GEMINI_ARRANGER_MODEL", "gemini-2.5-flash").strip()

SYSTEM_PROMPT = """
You are an expert audio arranger and DSP music supervisor.
Convert the user's creative prompt into a structured, track-level JSON blueprint.
Rules:
1. Determine exact Target BPM (60-180) and Musical Root Key (e.g., "A", "C#", "F").
2. Break the track into 5-8 distinct sections (intro, verse_1, build, chorus, verse_2, drop, outro).
3. Assign energy (0.0 to 1.0) and exact volume weights (0.0 to 1.0) for rhythm, harmonic, lead, and vocal stems.
4. Output specific corpus search tags for each stem layer to query the sample database.
5. Return RAW JSON ONLY. No conversational filler or markdown blocks.
""".strip()

_KEY_NOTE = r"([A-Ga-g](?:#|b|♯|♭)?)"
_KEY_RE = re.compile(
    rf"(?:key(?:\s+of)?|in\s+the\s+key\s+of|root|\bin)\s*[:\s]+{_KEY_NOTE}(?!\w)",
    re.IGNORECASE,
)
_KEY_BARE_RE = re.compile(rf"\b{_KEY_NOTE}(?!\w)")
_BPM_RE = re.compile(r"\b(\d{2,3})\s*bpm\b", re.IGNORECASE)
_BPM_BARE_RE = re.compile(r"\bbpm\s*[:\s]+(\d{2,3})\b", re.IGNORECASE)

_GENRE_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("dark_electronic_rock", ("dark electronic", "electronic rock", "industrial rock")),
    ("alt_rock", ("alt rock", "alternative rock", "modern rock", "indie rock")),
    ("heavy_alternative_rock", ("heavy alternative", "heavy modern")),
    ("techno", ("techno",)),
    ("house", ("house", "deep house")),
    ("hip_hop", ("hip hop", "hip-hop", "rap")),
    ("metal", ("metal", "nu metal", "djent")),
    ("ambient", ("ambient", "drone")),
    ("pop", ("pop",)),
    ("edm", ("edm", "dubstep", "dnb", "drum and bass")),
    ("jazz", ("jazz",)),
    ("rnb", ("r&b", "rnb", "soul")),
)


def _load_env_quiet() -> None:
    scripts = os.path.join(_REPO, "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    try:
        import hybrid_env

        hybrid_env.load_env(verbose=False)
    except Exception:
        return


def _env_key(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def replicate_token() -> str:
    return _env_key("REPLICATE_API_TOKEN", "REPLICATE_API_KEY")


def gemini_native_key() -> str:
    return _env_key("GEMINI_API_KEY", "GOOGLE_API_KEY")


def known_genre_slugs() -> list[str]:
    slugs = [slug for slug, _hints in _GENRE_HINTS]
    workstation = r"D:\MusicDatasets\scripts"
    for folder in (workstation, os.path.join(_REPO, "scripts")):
        if folder not in sys.path and os.path.isdir(folder):
            sys.path.append(folder)
    try:
        from genre_master_profiles import GENRE_MASTER_PROFILES  # type: ignore

        slugs.extend(str(key) for key in GENRE_MASTER_PROFILES.keys())
    except Exception:
        pass
    try:
        from genre_resolver import ALIAS_MAP  # type: ignore

        slugs.extend(str(key) for key in ALIAS_MAP.keys())
    except Exception:
        pass
    return list(dict.fromkeys(slugs))


def infer_genre(prompt: str, override: str | None = None) -> str:
    if override and str(override).strip():
        return str(override).strip()
    blob = (prompt or "").lower()
    for slug, hints in _GENRE_HINTS:
        if any(hint in blob for hint in hints):
            return slug
    for slug in known_genre_slugs():
        token = slug.replace("_", " ")
        if token and token in blob:
            return slug
    return "alt_rock"


def infer_bpm(prompt: str, default: float = 120.0) -> float:
    text = prompt or ""
    match = _BPM_RE.search(text) or _BPM_BARE_RE.search(text)
    if match:
        return float(int(match.group(1)))
    return float(default)


def infer_root_key(prompt: str, default: str = "A") -> str:
    text = prompt or ""
    match = _KEY_RE.search(text)
    if match:
        return match.group(1)
    match = _KEY_BARE_RE.search(text)
    if match:
        return match.group(1)
    return default


def _title_from_prompt(prompt: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", prompt or "")
    if not words:
        return "Generated_Track_01"
    return "_".join(words[:6])[:48] or "Generated_Track_01"


def heuristic_blueprint(prompt: str, genre: str | None = None) -> ArrangementBlueprint:
    """Valid 5–8 section blueprint from prompt keywords (no network)."""
    slug = infer_genre(prompt, genre)
    bpm = infer_bpm(prompt)
    root = infer_root_key(prompt)
    rockish = any(token in slug for token in ("rock", "metal", "punk"))
    electronic = any(token in slug for token in ("techno", "house", "edm", "electronic"))
    rhythm_tags = ["drums", "kick", "punchy"] if rockish else ["drums", "rhythm", "loop"]
    harm_tags = ["guitar", "distorted"] if rockish else (["pad", "synth"] if electronic else ["pad", "harmonic"])
    lead_tags = ["guitar", "lead"] if rockish else ["lead", "pluck"]
    vocal_tags = ["vocal"] if "vocal" in (prompt or "").lower() else []
    sections = [
        {
            "name": "intro",
            "slice_count": 4,
            "energy": 0.30,
            "volume_weights": {"rhythm": 0.35, "harmonic": 0.70, "lead": 0.20, "vocal": 0.00},
            "query_tags": {
                "rhythm": ["sparse", "hat"] + rhythm_tags[:1],
                "harmonic": ["pad", "drone"] + harm_tags[:1],
                "lead": ["ambient"] + lead_tags[:1],
                "vocal": [],
            },
            "dsp_filters": {"lowpass_hz": 4200, "reverb_send": 0.40, "saturation_drive": 0.10},
        },
        {
            "name": "verse_1",
            "slice_count": 6,
            "energy": 0.55,
            "volume_weights": {"rhythm": 0.70, "harmonic": 0.65, "lead": 0.35, "vocal": 0.25},
            "query_tags": {
                "rhythm": rhythm_tags,
                "harmonic": harm_tags,
                "lead": lead_tags,
                "vocal": vocal_tags,
            },
            "dsp_filters": {"lowpass_hz": 12000, "reverb_send": 0.25, "saturation_drive": 0.20},
        },
        {
            "name": "build",
            "slice_count": 4,
            "energy": 0.75,
            "volume_weights": {"rhythm": 0.80, "harmonic": 0.60, "lead": 0.55, "vocal": 0.15},
            "query_tags": {
                "rhythm": rhythm_tags + ["snare"],
                "harmonic": harm_tags,
                "lead": lead_tags + ["riff"],
                "vocal": vocal_tags,
            },
            "dsp_filters": {"lowpass_hz": 16000, "reverb_send": 0.20, "saturation_drive": 0.30},
        },
        {
            "name": "chorus",
            "slice_count": 8,
            "energy": 0.92,
            "volume_weights": {"rhythm": 0.90, "harmonic": 0.75, "lead": 0.80, "vocal": 0.45},
            "query_tags": {
                "rhythm": ["heavy"] + rhythm_tags,
                "harmonic": harm_tags,
                "lead": lead_tags,
                "vocal": vocal_tags or ["vocal"],
            },
            "dsp_filters": {"lowpass_hz": 20000, "reverb_send": 0.15, "saturation_drive": 0.40},
        },
        {
            "name": "verse_2",
            "slice_count": 6,
            "energy": 0.60,
            "volume_weights": {"rhythm": 0.72, "harmonic": 0.62, "lead": 0.40, "vocal": 0.30},
            "query_tags": {
                "rhythm": rhythm_tags,
                "harmonic": harm_tags,
                "lead": lead_tags,
                "vocal": vocal_tags,
            },
            "dsp_filters": {"lowpass_hz": 14000, "reverb_send": 0.22, "saturation_drive": 0.22},
        },
        {
            "name": "drop",
            "slice_count": 6,
            "energy": 0.95,
            "volume_weights": {"rhythm": 0.92, "harmonic": 0.70, "lead": 0.85, "vocal": 0.20},
            "query_tags": {
                "rhythm": ["punchy"] + rhythm_tags,
                "harmonic": harm_tags,
                "lead": ["solo"] + lead_tags,
                "vocal": [],
            },
            "dsp_filters": {"lowpass_hz": 20000, "reverb_send": 0.12, "saturation_drive": 0.45},
        },
        {
            "name": "outro",
            "slice_count": 4,
            "energy": 0.28,
            "volume_weights": {"rhythm": 0.40, "harmonic": 0.55, "lead": 0.15, "vocal": 0.00},
            "query_tags": {
                "rhythm": ["sparse"] + rhythm_tags[:1],
                "harmonic": ["pad"] + harm_tags[:1],
                "lead": lead_tags[:1],
                "vocal": [],
            },
            "dsp_filters": {"lowpass_hz": 3500, "reverb_send": 0.50, "saturation_drive": 0.08},
        },
    ]
    raw = {
        "track_metadata": {
            "title": _title_from_prompt(prompt),
            "bpm": bpm,
            "root_key": root,
            "genre": slug,
            "total_bars": 0,
        },
        "sections": sections,
    }
    return validate_blueprint(raw, enforce_section_span=True)


def _join_output(output: Any) -> str:
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    if isinstance(output, (list, tuple)):
        return "".join(_join_output(part) for part in output)
    if isinstance(output, dict):
        for key in ("text", "output", "content"):
            if key in output:
                return _join_output(output[key])
    return str(output)


def _http_json(url: str, token: str | None, payload: dict | None, timeout: float = 120.0) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method="POST" if payload is not None else "GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:240]
        raise RuntimeError(f"HTTP {exc.code}") from None


def _call_replicate(prompt: str, genre: str | None, token: str, model: str) -> dict:
    user = (
        f"Prompt: {prompt}\n"
        f"Genre override: {genre or 'infer from prompt'}\n"
        "Return the arrangement JSON now. RAW JSON only."
    )
    payload = {
        "input": {
            "prompt": user,
            "system_instruction": SYSTEM_PROMPT,
            "temperature": 0.3,
            "max_output_tokens": 2048,
            "thinking_budget": 0,
        }
    }
    try:
        import replicate

        client = replicate.Client(api_token=token)
        output = client.run(model, input=payload["input"])
        return json.loads(strip_json_fences(_join_output(output)))
    except Exception as package_exc:
        if "replicate" in str(package_exc).lower() and "No module" in str(package_exc):
            pass
        elif not isinstance(package_exc, (json.JSONDecodeError, BlueprintValidationError, RuntimeError)):
            # Prefer urllib if the SDK is missing; re-raise other SDK failures after urllib try.
            pass
        created = _http_json(f"{REPLICATE_API}/models/{model}/predictions", token, payload)
        prediction = created
        deadline = time.time() + 180
        while prediction.get("status") not in {"succeeded", "failed", "canceled", None}:
            if time.time() > deadline:
                raise RuntimeError("Replicate arrangement timed out")
            time.sleep(1.5)
            pred_id = prediction.get("id")
            if not pred_id:
                break
            prediction = _http_json(f"{REPLICATE_API}/predictions/{pred_id}", token, None)
        if prediction.get("status") != "succeeded":
            raise RuntimeError(f"Replicate failed: {prediction.get('status')}")
        return json.loads(strip_json_fences(_join_output(prediction.get("output"))))


def _call_native_gemini(prompt: str, genre: str | None, api_key: str) -> dict:
    model = NATIVE_GEMINI_MODEL.replace("google/", "")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    user = (
        f"Prompt: {prompt}\n"
        f"Genre override: {genre or 'infer from prompt'}\n"
        "Return RAW JSON only."
    )
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 2048,
            "responseMimeType": "application/json",
        },
    }
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            ),
            timeout=120,
        ) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise RuntimeError("Native Gemini HTTP error") from None
    parts = (
        ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    )
    text = "".join(str(part.get("text") or "") for part in parts)
    return json.loads(strip_json_fences(text))


def call_live_arranger(prompt: str, genre: str | None = None) -> tuple[dict, str]:
    """Call Replicate Gemini or native Gemini. Returns (raw_json, backend_label)."""
    _load_env_quiet()
    token = replicate_token()
    native = gemini_native_key()
    if token:
        raw = _call_replicate(prompt, genre, token, DEFAULT_REPLICATE_MODEL)
        return raw, DEFAULT_REPLICATE_MODEL
    if native:
        raw = _call_native_gemini(prompt, genre, native)
        return raw, f"native:{NATIVE_GEMINI_MODEL}"
    raise RuntimeError("no Replicate or Gemini API key in the environment")


def arrange_from_prompt(
    prompt: str,
    genre: str | None = None,
    *,
    offline: bool = True,
    live: bool = False,
) -> tuple[ArrangementBlueprint, str]:
    """Return (blueprint, mode) where mode is ``offline`` or the model slug."""
    if live and not offline:
        try:
            raw, label = call_live_arranger(prompt, genre)
            if genre:
                if isinstance(raw, dict):
                    meta = raw.setdefault("track_metadata", {})
                    if isinstance(meta, dict) and not meta.get("genre"):
                        meta["genre"] = genre
            return validate_blueprint(raw, enforce_section_span=True), label
        except Exception as exc:
            print(f"[WARN] Live arrange failed ({type(exc).__name__}); using offline heuristic.")
            return heuristic_blueprint(prompt, genre), "offline"
    return heuristic_blueprint(prompt, genre), "offline"


def write_blueprint(blueprint: ArrangementBlueprint, dest: str) -> str:
    parent = os.path.dirname(os.path.abspath(dest))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(dest, "w", encoding="utf-8") as handle:
        json.dump(blueprint, handle, indent=2)
    return dest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gemini / heuristic arrangement blueprint")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--genre", default=None)
    parser.add_argument("--offline", action="store_true", default=False)
    parser.add_argument("--live", action="store_true", default=False)
    args = parser.parse_args(argv)
    offline = True
    live = False
    if args.live:
        offline = False
        live = True
    elif args.offline:
        offline = True
        live = False
    else:
        # Default offline unless --live. Do not call Gemini without --live.
        offline = True
        live = False
    try:
        blueprint, mode = arrange_from_prompt(
            args.prompt,
            args.genre,
            offline=offline,
            live=live,
        )
    except BlueprintValidationError as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 1
    write_blueprint(blueprint, args.out)
    print(f"[ARRANGE] mode={mode} out={args.out} sections={len(blueprint['sections'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
