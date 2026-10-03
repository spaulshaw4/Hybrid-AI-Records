"""Turn Gemini ``source: generate`` lanes into local wavs before the tape runs.

Audio models use the hybrid Replicate token (``REPLICATE_API_TOKEN``). The
lyric key stays on the Gemini plan call and is not used here.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "catalog", "generated_stems")
VOCAL_MODEL = "suno-ai/bark"
INSTRUMENT_MODEL = "meta/musicgen"
_MAX_GENERATIONS = 6
_MAX_DURATION_SEC = 30

LANE_TO_BUS = {
    "01_kick": "rhythm",
    "02_snare": "rhythm",
    "03_tops": "rhythm",
    "04_aux_perc": "rhythm",
    "05_sub_bass": "bass",
    "06_mid_bass": "bass",
    "07_primary_comp": "harmonic",
    "08_harmonic_bed": "harmonic",
    "09_secondary_comp": "harmonic",
    "10_lead_inst": "harmonic",
    "11_lead_vocal": "vocal",
    "12_vocal_backing": "vocal",
    "13_transitions_fx": "rhythm",
}


def _longest_run(bars: list[int]) -> int:
    if not bars:
        return 1
    best = span = 1
    for previous, bar in zip(bars, bars[1:]):
        if bar == previous + 1:
            span += 1
            best = max(best, span)
        else:
            span = 1
    return best


def _audio_url(output: Any) -> str:
    url = getattr(output, "url", None)
    if isinstance(url, str) and url.startswith("http"):
        return url
    if isinstance(output, str) and output.startswith("http"):
        return output
    if isinstance(output, dict):
        for key in ("audio_out", "audio", "wav", "output"):
            if key in output:
                return _audio_url(output[key])
    if isinstance(output, (list, tuple)) and output:
        return _audio_url(output[0])
    raise RuntimeError("Replicate audio response had no file URL")


def _predict(model: str, payload: dict[str, Any], token: str, timeout: float = 180.0) -> Any:
    from engine.gemini_arranger import REPLICATE_API, _http_json

    created = _http_json(
        f"{REPLICATE_API}/models/{model}/predictions",
        token,
        {"input": payload},
        timeout=timeout,
    )
    deadline = time.time() + float(timeout)
    prediction = created
    while prediction.get("status") not in {"succeeded", "failed", "canceled", None}:
        if time.time() > deadline:
            raise RuntimeError("audio generation timed out")
        time.sleep(1.5)
        pred_id = prediction.get("id")
        if not pred_id:
            break
        prediction = _http_json(f"{REPLICATE_API}/predictions/{pred_id}", token, None, timeout=timeout)
    if prediction.get("status") != "succeeded":
        raise RuntimeError(str(prediction.get("error") or "audio generation failed"))
    return prediction.get("output")


def _download(url: str, dest: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "hybrid-ai-forge"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    if len(data) < 64:
        raise RuntimeError("downloaded audio was empty")
    with open(dest, "wb") as handle:
        handle.write(data)


def load_and_resample_generated_wav(
    raw_bytes: bytes,
    target_sr: int = 44100,
    *,
    mono: bool = False,
) -> np.ndarray:
    """Decode a generated wav and put it on the session rate.

    ``soundfile`` consumes the RIFF header, so those bytes never become a
    click at the start of the slice. Bark's native 24 kHz is resampled onto
    ``target_sr`` (the render rate, 44100 unless the session asked for 48000).
    Vocal takes are folded to mono. Instrument takes keep their channels.
    """
    import io

    import soundfile as sf

    audio, native_sr = sf.read(io.BytesIO(raw_bytes), always_2d=True)
    audio = np.asarray(audio, dtype=np.float64)
    if audio.size == 0:
        raise RuntimeError("generated wav had no samples")
    if mono and audio.shape[1] > 1:
        audio = np.mean(audio, axis=1, keepdims=True)
    if int(native_sr) != int(target_sr) and audio.shape[0] > 1:
        import librosa

        channels = [
            librosa.resample(audio[:, ch], orig_sr=int(native_sr), target_sr=int(target_sr))
            for ch in range(audio.shape[1])
        ]
        count = min(int(channel.shape[0]) for channel in channels)
        audio = np.stack([channel[:count] for channel in channels], axis=1)
    return np.ascontiguousarray(audio, dtype=np.float32)


def _fit_to_bars(path: str, sr: int, bpm: float, bars: int, *, mono: bool = False) -> None:
    """Stretch or pad the new file to the bar window it was asked to fill."""
    import soundfile as sf

    from dsp.tempo_time_stretch import lock_slice_to_tempo
    from engine.blueprint_track_assembler import samples_per_bar

    with open(path, "rb") as handle:
        raw = handle.read()
    audio = np.asarray(load_and_resample_generated_wav(raw, target_sr=int(sr), mono=mono), dtype=np.float64)
    target = max(1, int(bars)) * samples_per_bar(int(sr), float(bpm))
    current = float(bpm) * (float(target) / float(audio.shape[0])) if audio.shape[0] else float(bpm)
    fitted = lock_slice_to_tempo(
        audio,
        target_bpm=float(bpm),
        sr=int(sr),
        target_samples=int(target),
        original_bpm=current,
    )
    sf.write(path, np.asarray(fitted, dtype=np.float64), int(sr), subtype="FLOAT")


def _run_replicate(model: str, payload: dict[str, Any], token: str) -> Any:
    """Blocking Replicate call. Model slugs, not pinned version hashes.

    A failed SDK run is not retried over HTTP: the prediction may already
    have been billed.
    """
    try:
        import replicate
    except ImportError:
        return _predict(model, payload, token)
    client = replicate.Client(api_token=token)
    return client.run(model, input=payload)


def _save_output(output: Any, dest: str) -> None:
    reader = getattr(output, "read", None)
    if callable(reader) and not isinstance(output, (str, bytes, dict, list, tuple)):
        data = reader()
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)) or len(data) < 64:
            raise RuntimeError("downloaded audio was empty")
        with open(dest, "wb") as handle:
            handle.write(data)
        return
    _download(_audio_url(output), dest)


def generate_audio_via_replicate(
    prompt: str,
    is_vocal: bool,
    dest_dir: str | None = None,
    duration_sec: float | None = None,
) -> str:
    """Synthesize one stem on Replicate and return the local wav path.

    Audio models use ``REPLICATE_API_TOKEN``. The lyric key stays on the
    Gemini plan and is not accepted here.
    """
    from engine.gemini_arranger import replicate_token

    token = replicate_token()
    if not token:
        raise RuntimeError("audio generation requires REPLICATE_API_TOKEN")
    folder = dest_dir or CACHE_DIR
    os.makedirs(folder, exist_ok=True)
    seconds = int(max(1, min(_MAX_DURATION_SEC, round(float(duration_sec or 8)))))
    kind = "vocal" if is_vocal else "instrument"
    digest = hashlib.sha1(f"{kind}|{seconds}|{prompt}".encode("utf-8")).hexdigest()[:12]
    dest = os.path.join(folder, f"gen_{digest}.wav")
    if os.path.isfile(dest) and os.path.getsize(dest) > 64:
        print(f"[PRE-FLIGHT] reuse {os.path.basename(dest)}", flush=True)
        return dest
    text = str(prompt or "").strip()
    if not text:
        raise RuntimeError("empty generate prompt")
    print(f"[PRE-FLIGHT] Generating {kind}: {text[:80]}", flush=True)
    if is_vocal:
        output = _run_replicate(VOCAL_MODEL, {"prompt": text, "text_temp": 0.7}, token)
    else:
        output = _run_replicate(
            INSTRUMENT_MODEL,
            {
                "prompt": text,
                "duration": seconds,
                "output_format": "wav",
                "model_version": "stereo-large",
            },
            token,
        )
    _save_output(output, dest)
    print(f"[PRE-FLIGHT] Downloaded generated stem to {dest}", flush=True)
    return dest


async def generate_single_stem(
    prompt: str,
    is_vocal: bool,
    dest_dir: str | None = None,
    duration_sec: float | None = None,
) -> str:
    """One Bark or MusicGen stem. The blocking client runs on a worker thread."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        lambda prompt=prompt, is_vocal=is_vocal, dest_dir=dest_dir, duration_sec=duration_sec: (
            generate_audio_via_replicate(prompt, is_vocal, dest_dir, duration_sec)
        ),
    )


@dataclass
class _StemJob:
    prompt: str
    is_vocal: bool
    bars: int
    duration_sec: float


def _bar_numbers(raw: Any) -> list[int]:
    bars: list[int] = []
    for bar in raw or []:
        try:
            bars.append(int(bar))
        except (TypeError, ValueError):
            continue
    return bars


async def generate_all_stems(jobs: list[_StemJob], dest_dir: str) -> list[Any]:
    """Fire every Replicate stem at once. One 15s model does not block the next."""
    tasks = [
        generate_single_stem(job.prompt, job.is_vocal, dest_dir, job.duration_sec)
        for job in jobs
    ]
    return list(await asyncio.gather(*tasks, return_exceptions=True))


def _run_async(factory):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(factory())
    outcome: list[Any] = []
    error: list[BaseException] = []

    def runner() -> None:
        try:
            outcome.append(asyncio.run(factory()))
        except BaseException as exc:
            error.append(exc)

    import threading

    thread = threading.Thread(target=runner)
    thread.start()
    thread.join()
    if error:
        raise error[0]
    return outcome[0]


def _fit_job(job: tuple) -> tuple[str, BaseException | None]:
    path, sr, bpm, bars = job[:4]
    mono = bool(job[4]) if len(job) > 4 else False
    try:
        _fit_to_bars(path, int(sr), float(bpm), int(bars), mono=mono)
    except BaseException as exc:
        return path, exc
    return path, None


def warp_all_lanes_in_parallel(lane_tasks: list[tuple[str, int, float, int]]) -> dict[str, BaseException]:
    """Tempo-lock every new stem at once. Each task is ``(path, sr, bpm, bars)``."""
    if not lane_tasks:
        return {}
    failures: dict[str, BaseException] = {}
    with ThreadPoolExecutor(max_workers=min(13, len(lane_tasks))) as executor:
        for path, exc in executor.map(_fit_job, lane_tasks):
            if exc is not None:
                failures[path] = exc
    return failures


async def resolve_blueprint_dependencies_async(
    json_plan: dict,
    dest_dir: str | None = None,
    *,
    bpm: float = 120.0,
    sr: int = 44100,
) -> dict:
    """Generate every ``source: generate`` lane at once, then point the plan at the wavs."""
    from engine.arrangement_planner import stem_id_from_path

    structure = json_plan.get("structure") if isinstance(json_plan, dict) else None
    if not isinstance(structure, list):
        return json_plan
    folder = dest_dir or CACHE_DIR
    jobs: dict[str, _StemJob] = {}
    bindings: list[tuple[dict, str, str]] = []
    for section in structure:
        if not isinstance(section, dict):
            continue
        lanes = section.get("lane_assignments")
        if not isinstance(lanes, dict):
            continue
        for lane_name, config in list(lanes.items()):
            if not isinstance(config, dict) or config.get("source") != "generate":
                continue
            is_vocal = "vocal" in str(lane_name).lower() or bool(config.get("lyrics"))
            gen_prompt = str(config.get("lyrics") or config.get("prompt") or "").strip()
            if not gen_prompt:
                lanes.pop(lane_name, None)
                continue
            if gen_prompt not in jobs and len(jobs) >= _MAX_GENERATIONS:
                print(f"[PRE-FLIGHT] cap {_MAX_GENERATIONS}; dropped {lane_name}", flush=True)
                lanes.pop(lane_name, None)
                continue
            bars = _longest_run(_bar_numbers(config.get("active_bars")))
            duration = bars * 4.0 * 60.0 / float(bpm or 120.0)
            current = jobs.get(gen_prompt)
            if current is None:
                jobs[gen_prompt] = _StemJob(gen_prompt, is_vocal, bars, duration)
            else:
                current.bars = max(current.bars, bars)
                current.duration_sec = max(current.duration_sec, duration)
                current.is_vocal = current.is_vocal or is_vocal
            bindings.append((config, str(lane_name), gen_prompt))
    if not jobs:
        return json_plan
    ordered = list(jobs.values())
    print(f"[PRE-FLIGHT] Dispatching {len(ordered)} parallel stem generation jobs...", flush=True)
    results = await generate_all_stems(ordered, folder)
    path_for: dict[str, str] = {}
    failed: dict[str, BaseException] = {}
    fit_tasks: list[tuple[str, int, float, int]] = []
    for job, result in zip(ordered, results):
        if isinstance(result, BaseException):
            failed[job.prompt] = result
            continue
        path_for[job.prompt] = str(result)
        fit_tasks.append((str(result), int(sr), float(bpm), int(job.bars), bool(job.is_vocal)))
    for path, exc in warp_all_lanes_in_parallel(fit_tasks).items():
        prompt = next((item.prompt for item in ordered if path_for.get(item.prompt) == path), "")
        if prompt:
            failed[prompt] = exc
            path_for.pop(prompt, None)
    for config, lane_name, gen_prompt in bindings:
        exc = failed.get(gen_prompt)
        path = path_for.get(gen_prompt)
        if exc is not None or not path:
            print(
                f"[PRE-FLIGHT] {lane_name} skipped ({type(exc).__name__ if exc else 'missing'}: {exc})",
                flush=True,
            )
            for section in structure:
                lanes = section.get("lane_assignments") if isinstance(section, dict) else None
                if isinstance(lanes, dict) and lanes.get(lane_name) is config:
                    lanes.pop(lane_name, None)
            continue
        config["source"] = "catalog"
        config["stem_id"] = stem_id_from_path(path)
        config["path"] = path
    return json_plan


def resolve_blueprint_dependencies(
    json_plan: dict,
    dest_dir: str | None = None,
    *,
    bpm: float = 120.0,
    sr: int = 44100,
) -> dict:
    """Synchronous entry used by the tape after the Gemini plan returns."""
    return _run_async(
        lambda: resolve_blueprint_dependencies_async(json_plan, dest_dir, bpm=bpm, sr=sr)
    )


def mix_generated_lanes(
    arrangement: Mapping[str, Any],
    section_samples: list[int],
    sr: int,
    bpm: float,
    channels: int,
    total_samples: int,
    only_lane: str | None = None,
) -> dict[str, np.ndarray]:
    """Place each generated wav on its active bars. The section mute does not apply."""
    from engine.arrangement_planner import place_stem_on_bars

    structure = arrangement.get("structure") if isinstance(arrangement, Mapping) else None
    if not isinstance(structure, list):
        return {}
    cache: dict[str, np.ndarray] = {}
    rendered: dict[str, np.ndarray] = {}
    cursor = 0
    width = max(1, int(channels))
    for index, section in enumerate(structure):
        length = int(section_samples[index]) if index < len(section_samples) else 0
        if not isinstance(section, dict):
            cursor += length
            continue
        lanes = section.get("lane_assignments")
        if isinstance(lanes, dict):
            for lane, config in lanes.items():
                if only_lane is not None and str(lane) != only_lane:
                    continue
                if not isinstance(config, dict):
                    continue
                path = str(config.get("path") or "")
                if not path or not os.path.isfile(path):
                    continue
                audio = cache.get(path)
                if audio is None:
                    with open(path, "rb") as handle:
                        raw = handle.read()
                    data = load_and_resample_generated_wav(raw, target_sr=int(sr))
                    audio = np.asarray(data, dtype=np.float64)
                    if audio.shape[1] == 1 and width == 2:
                        audio = np.repeat(audio, 2, axis=1)
                    elif audio.shape[1] != width:
                        audio = audio[:, :width]
                    cache[path] = audio
                placed = place_stem_on_bars(
                    audio,
                    int(sr),
                    float(bpm),
                    list(config.get("active_bars") or []),
                    int(total_samples),
                    section_offset=int(cursor),
                )
                bucket = rendered.get(str(lane))
                rendered[str(lane)] = placed if bucket is None else bucket + placed
        cursor += length
    return rendered
