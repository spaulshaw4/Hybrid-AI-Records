"""Shovel long sources into a session workspace, then assemble a master.

Phrase roles are cut on silence or a zero-crossing inside the session folder.
The shared blueprint on disk is copied before a genre stamp, and nothing is
written under the live corpus or ``uploaded_slices``.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.blueprint_track_assembler import assemble_from_blueprint  # noqa: E402
from engine.local_track_synthesizer import assemble_local_track  # noqa: E402

ONESHOT_SEC = 1.5


def _wavs(corpus: str) -> list[str]:
    found: list[str] = []
    if not os.path.isdir(corpus):
        return found
    for root, dirs, files in os.walk(corpus):
        dirs[:] = [name for name in dirs if name.lower() != "uploaded_slices"]
        for name in files:
            if name.lower().endswith(".wav"):
                found.append(os.path.join(root, name))
    return sorted(found)


def _duration(path: str) -> float:
    import soundfile as sf

    try:
        return float(sf.info(path).duration)
    except Exception:
        return 0.0


def shovel_into_session(corpus: str, session_dir: str, slice_duration: float) -> str:
    """Phrase-slice sources longer than the grid into ``session_dir/slices``.

    Files already on the grid are left where they are. One-shots are copied,
    not stretched to 4 seconds. ``uploaded_slices`` is refused.
    """
    wavs = _wavs(corpus)
    if not wavs:
        return corpus
    durations = [_duration(path) for path in wavs]
    grid = float(slice_duration)
    if not any(dur > grid * 1.15 for dur in durations):
        return corpus

    from dsp.smart_transient_slicer import assert_raw_source, slice_audio_file

    assert_raw_source(corpus, wavs)
    dest = os.path.join(session_dir, "slices")
    os.makedirs(dest, exist_ok=True)
    for path, dur in zip(wavs, durations):
        if dur < ONESHOT_SEC:
            shutil.copy2(path, os.path.join(dest, os.path.basename(path)))
        elif dur > grid * 1.15:
            slice_audio_file(path, dest, nominal_dur=grid)
        else:
            shutil.copy2(path, os.path.join(dest, os.path.basename(path)))
    return dest


def stamp_session_blueprint(blueprint_path: str, output_dir: str, genre: str) -> str:
    """Write a session copy with ``genre`` set. The source file is not rewritten."""
    with open(blueprint_path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        data = {"sections": data}
    data["genre"] = genre
    plan = data.get("song_plan")
    if isinstance(plan, dict):
        plan["genre"] = genre
    os.makedirs(output_dir, exist_ok=True)
    dest = os.path.join(output_dir, "arrangement.json")
    with open(dest, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    return dest


def stage_session(session_id: str, output_dir: str, slice_duration: float, genre: str, corpus: str) -> str:
    os.makedirs(output_dir, exist_ok=True)
    master_out = os.path.join(output_dir, "master_output.wav")
    blueprint = os.path.join(output_dir, "arrangement.json")
    source_blueprint = blueprint if os.path.isfile(blueprint) else None
    if source_blueprint is None:
        fallback = r"D:\MusicDatasets\scratch\gemini_arrangement.json"
        if os.path.isfile(fallback):
            source_blueprint = fallback
        else:
            workspace = shovel_into_session(corpus, output_dir, slice_duration)
            assemble_local_track(workspace, master_out, target_length_sec=180.0, max_slices=64)
            print(f"[STAGED] {master_out}")
            return master_out

    session_blueprint = stamp_session_blueprint(source_blueprint, output_dir, genre)
    workspace = shovel_into_session(corpus, output_dir, slice_duration)
    assemble_from_blueprint(session_blueprint, workspace, master_out)
    print(f"[STAGED] {master_out} session={session_id} genre={genre} slice={slice_duration}s")
    return master_out


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--slice-duration", type=float, default=4.0)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--genre", default="alt_rock")
    parser.add_argument("--corpus", default=r"D:\MusicDatasets\corpus_4s")
    args = parser.parse_args()
    stage_session(args.session_id, args.output_dir, args.slice_duration, args.genre, args.corpus)
