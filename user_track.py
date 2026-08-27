#!/usr/bin/env python3
"""User-stem mix + optional Replicate lyrics (text only, not mixed into audio).

`sum_and_master_stems` only sums and applies peak headroom. This module masters
exactly once via `master_audio` → `apply_mastering_chain`. Lyrics from Replicate
are returned as text; there is no TTS/vocal-synthesis path here.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent

DEFAULT_LYRICS_MODEL = "meta/meta-llama-3-70b-instruct"
LYRICS_SYSTEM_PROMPT = (
    "You are a professional studio lyricist and arrangement assistant. "
    "Keep phrasing rhythmic and production-ready."
)
ProgressFn = Callable[[str, float, str], None]


def _default_scratch() -> Path:
    if Path("/workspace").is_dir():
        path = Path("/workspace/scratch")
    else:
        path = ROOT / ".ingest_vault"
    path.mkdir(parents=True, exist_ok=True)
    return path


def replicate_token() -> str:
    token = (os.environ.get("REPLICATE_API_TOKEN") or "").strip()
    if not token:
        token = (os.environ.get("REPLICATE_API_KEY") or "").strip()
    if not token:
        raise ValueError("REPLICATE_API_TOKEN environment variable is not set.")
    return token


def lyrics_model() -> str:
    return (
        os.environ.get("REPLICATE_LYRICS_MODEL") or DEFAULT_LYRICS_MODEL
    ).strip() or DEFAULT_LYRICS_MODEL


def usable_webhook_url(url: str | None) -> str | None:
    """Skip unset, blank, and placeholder webhook destinations."""
    if not url or not str(url).strip():
        return None
    value = str(url).strip()
    lowered = value.lower()
    if "your-hybrid-frontend.com" in lowered:
        return None
    if "example.com" in lowered or "placeholder" in lowered:
        return None
    return value


def coerce_replicate_text(output: object) -> str:
    """Replicate LLM output may be a string, list, or iterator of strings."""
    if output is None:
        return ""
    if isinstance(output, str):
        return output.strip()
    if isinstance(output, bytes):
        return output.decode("utf-8", errors="replace").strip()
    if isinstance(output, dict):
        for key in ("text", "output", "lyrics", "content"):
            if key in output:
                return coerce_replicate_text(output[key])
        return ""
    if isinstance(output, (list, tuple)):
        return "".join(coerce_replicate_text(part) for part in output).strip()
    if hasattr(output, "__iter__"):
        parts: list[str] = []
        try:
            for item in output:
                if item is None:
                    continue
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, bytes):
                    parts.append(item.decode("utf-8", errors="replace"))
                else:
                    parts.append(str(item))
        except TypeError:
            return str(output).strip()
        return "".join(parts).strip()
    return str(output).strip()


def generate_user_lyrics(prompt_text: str) -> str:
    if not prompt_text or not str(prompt_text).strip():
        raise ValueError("lyric prompt text is required.")
    token = replicate_token()
    try:
        import replicate
    except ImportError as exc:
        raise RuntimeError(
            "The 'replicate' package is required. pip install replicate"
        ) from exc

    model = lyrics_model()
    input_payload = {
        "prompt": str(prompt_text).strip(),
        "system_prompt": LYRICS_SYSTEM_PROMPT,
        "temperature": 0.8,
        "max_new_tokens": 300,
    }
    client = replicate.Client(api_token=token)
    output = client.run(model, input=input_payload)
    lyrics = coerce_replicate_text(output)
    if not lyrics:
        raise RuntimeError(f"Replicate model {model} returned empty lyrics.")
    return lyrics


def _job_paths(output_dir: str, job_id: str) -> tuple[str, str, str]:
    work = Path(output_dir)
    work.mkdir(parents=True, exist_ok=True)
    pre_master = str(work / f"{job_id}_pre.wav")
    final_master = str(work / f"{job_id}_final.wav")
    lyrics_path = str(work / f"{job_id}_lyrics.txt")
    return pre_master, final_master, lyrics_path


def sum_user_stems(stem_paths: dict, pre_master_path: str) -> str:
    """Peak-limited stereo sum only. Does not run the mastering chain."""
    from sum_stems import sum_and_master_stems

    return sum_and_master_stems(stem_paths, pre_master_path)


def master_user_sum(
    pre_master_path: str,
    final_master_path: str,
    target_lufs: float = -14.0,
) -> str:
    """Apply the existing Pedalboard chain exactly once."""
    from master_audio import master_audio

    return master_audio(pre_master_path, final_master_path, target_lufs=target_lufs)


def mix_user_stems_once(
    stem_paths: dict,
    output_dir: str,
    job_id: str,
    target_lufs: float = -14.0,
    progress: ProgressFn | None = None,
) -> dict[str, str]:
    """Sum user stems, then apply the Pedalboard chain exactly once."""
    pre_master, final_master, _lyrics_path = _job_paths(output_dir, job_id)
    if progress:
        progress("summing", 25, "Summing and aligning stems...")
    sum_user_stems(stem_paths, pre_master)
    if progress:
        progress("mastering", 75, "Applying Pedalboard mastering chain (-14 LUFS)...")
    master_user_sum(pre_master, final_master, target_lufs=target_lufs)
    return {
        "pre_master_path": pre_master,
        "master_path": final_master,
    }


def process_user_track(
    stem_paths: dict,
    lyric_prompt: str = "",
    output_dir: str | None = None,
    job_id: str | None = None,
    target_lufs: float = -14.0,
    progress: ProgressFn | None = None,
) -> dict:
    """Generate lyrics (text), sum stems, master once. Returns master_path + lyrics.

    Lyrics are not synthesized or mixed into the WAV. The returned master is the
    summed user stems after a single `apply_mastering_chain` pass.
    """
    if not isinstance(stem_paths, dict) or not stem_paths:
        raise ValueError("stem_paths must be a non-empty dict of role → file path.")

    resolved_job_id = (job_id or "").strip() or str(uuid.uuid4())
    resolved_output = output_dir or str(_default_scratch() / resolved_job_id)
    Path(resolved_output).mkdir(parents=True, exist_ok=True)

    lyrics = ""
    prompt = (lyric_prompt or "").strip()
    if prompt:
        if progress:
            progress(
                "lyrics",
                10,
                "Generating studio lyrics (text only; not mixed into audio).",
            )
        lyrics = generate_user_lyrics(prompt)

    mixed = mix_user_stems_once(
        stem_paths,
        resolved_output,
        resolved_job_id,
        target_lufs=target_lufs,
        progress=progress,
    )
    _pre_master, _final_master, lyrics_path = _job_paths(resolved_output, resolved_job_id)
    Path(lyrics_path).write_text(lyrics, encoding="utf-8")
    if progress:
        progress("complete", 100, "Master complete and ready.")
    return {
        "job_id": resolved_job_id,
        "master_path": mixed["master_path"],
        "pre_master_path": mixed["pre_master_path"],
        "lyrics": lyrics,
        "lyrics_path": lyrics_path,
    }


def sample_stems(workspace: Path | None = None) -> dict[str, str]:
    root = workspace or (
        Path("/workspace/scratch") if Path("/workspace").is_dir() else Path("scratch")
    )
    return {
        "drums": str(root / "drums.wav"),
        "bass": str(root / "bass.wav"),
        "vocals": str(root / "vocals.wav"),
        "other": str(root / "other.wav"),
    }


if __name__ == "__main__":
    workspace = Path("/workspace/scratch") if Path("/workspace").is_dir() else Path("scratch")
    stems = sample_stems(workspace)
    missing = [path for path in stems.values() if not os.path.isfile(path)]
    if missing:
        raise FileNotFoundError(
            "sample_stems files are missing (no sample_stemens fallback): "
            + ", ".join(missing)
        )
    result = process_user_track(
        stems,
        lyric_prompt="Write a verse about late-night studio sessions.",
        output_dir=str(workspace),
    )
    print(result)
