"""Step 1: Gemini on Replicate returns a local-assembly arrangement JSON."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPLICATE_API = "https://api.replicate.com/v1"
DEFAULT_MODEL = os.environ.get("REPLICATE_GEMINI_MODEL", "google/gemini-2.5-flash").strip()

SYSTEM = """You are a studio arrangement engineer for a local slice-assembly engine.
Return JSON only. No markdown fences.
Schema:
{
  "genre": "string",
  "target_length_sec": 180,
  "sections": [
    {
      "name": "Intro" | "Verse" | "Drop_Chorus" | "Outro",
      "duration_sec": number,
      "slice_count": number,
      "layers": {"rhythm": 0.0-1.0, "harmonic": 0.0-1.0, "lead": 0.0-1.0}
    }
  ]
}
Rules:
- Sections must be Intro, Verse, Drop_Chorus, Outro in that order.
- slice_count = duration_sec / 4. Durations must be multiples of 4.
- Sum of duration_sec must equal target_length_sec.
- Intro is harmonic-led. Verse is rhythm+harmonic. Drop_Chorus is full stack. Outro tails off.
"""


def _token() -> str:
    for name in ("REPLICATE_API_TOKEN", "REPLICATE_API_KEY", "LYRIC_ENGINE_API_KEY"):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    raise SystemExit("[FATAL] No Replicate token in environment.")


def _join_output(output) -> str:
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "".join(_join_output(part) for part in output)
    if isinstance(output, dict):
        for key in ("text", "output", "content"):
            if key in output:
                return _join_output(output[key])
    return str(output)


def _request(url: str, token: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if payload is not None else "GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:400]
        raise SystemExit(f"[FATAL] Replicate HTTP {exc.code}: {body}") from exc


def _parse_json_text(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.rsplit("```", 1)[0].strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("Gemini response contained no JSON object")
    blob = cleaned[start : end + 1]
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        repaired = blob.replace(",]", "]").replace(",}", "}")
        repaired = repaired.replace("'", '"')
        return json.loads(repaired)


def arrange(prompt: str, genre: str, duration: float, model: str) -> dict:
    token = _token()
    user = (
        f"Prompt: {prompt}\n"
        f"Genre override: {genre}\n"
        f"target_length_sec: {duration}\n"
        "Return the arrangement JSON now."
    )
    created = _request(
        f"{REPLICATE_API}/models/{model}/predictions",
        token,
        {
            "input": {
                "prompt": user + "\n\nRespond with valid JSON only. No prose, no markdown fences.",
                "system_instruction": SYSTEM,
                "temperature": 0.4,
                "max_output_tokens": 2048,
                "thinking_budget": 0,
            }
        },
    )
    prediction = created
    deadline = time.time() + 180
    while prediction.get("status") not in {"succeeded", "failed", "canceled", None}:
        if time.time() > deadline:
            raise SystemExit("[FATAL] Gemini arrangement timed out.")
        time.sleep(1.5)
        pred_id = prediction.get("id")
        if not pred_id:
            break
        prediction = _request(f"{REPLICATE_API}/predictions/{pred_id}", token)

    if prediction.get("status") != "succeeded":
        raise SystemExit(f"[FATAL] Gemini failed: {prediction.get('error') or prediction.get('status')}")

    raw = _join_output(prediction.get("output"))
    try:
        arrangement = _parse_json_text(raw)
    except Exception as exc:
        print(f"[WARN] First Gemini JSON parse failed ({exc}). Retrying once...")
        created = _request(
            f"{REPLICATE_API}/models/{model}/predictions",
            token,
            {
                "input": {
                    "prompt": (
                        f"The previous reply was invalid JSON. Return ONLY valid JSON "
                        f"for this prompt.\nPrompt: {prompt}\nGenre: {genre}\n"
                        f"target_length_sec: {duration}"
                    ),
                    "system_instruction": SYSTEM,
                    "temperature": 0.1,
                    "max_output_tokens": 2048,
                    "thinking_budget": 0,
                }
            },
        )
        prediction = created
        deadline = time.time() + 180
        while prediction.get("status") not in {"succeeded", "failed", "canceled", None}:
            if time.time() > deadline:
                raise SystemExit("[FATAL] Gemini retry timed out.")
            time.sleep(1.5)
            pred_id = prediction.get("id")
            if not pred_id:
                break
            prediction = _request(f"{REPLICATE_API}/predictions/{pred_id}", token)
        if prediction.get("status") != "succeeded":
            raise SystemExit(f"[FATAL] Gemini retry failed: {prediction.get('error') or prediction.get('status')}")
        arrangement = _parse_json_text(_join_output(prediction.get("output")))
    arrangement.setdefault("genre", genre)
    arrangement.setdefault("target_length_sec", duration)
    arrangement.setdefault("prompt", prompt)
    return arrangement


def main() -> int:
    parser = argparse.ArgumentParser(description="Gemini arrangement via Replicate")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--genre", required=True)
    parser.add_argument("--duration", type=float, default=180.0)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    print("[STEP 1] Gemini on Replicate — requesting section breakdown...")
    arrangement = arrange(args.prompt, args.genre, args.duration, args.model)
    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(arrangement, indent=2), encoding="utf-8")

    print(json.dumps(arrangement, indent=2))
    print(f"[STEP 1] Arrangement written: {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
