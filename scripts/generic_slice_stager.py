"""Stage 4.0s corpus slices into a session workspace and write master_output.wav."""
from __future__ import annotations

import argparse
import os
import sys

ENGINE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "engine"))
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

from blueprint_track_assembler import assemble_from_blueprint  # noqa: E402
from local_track_synthesizer import assemble_local_track  # noqa: E402


def stage_session(session_id: str, output_dir: str, slice_duration: float, genre: str, corpus: str) -> str:
    os.makedirs(output_dir, exist_ok=True)
    master_out = os.path.join(output_dir, "master_output.wav")
    blueprint = os.path.join(output_dir, "arrangement.json")
    if not os.path.isfile(blueprint):
        fallback = r"D:\MusicDatasets\scratch\gemini_arrangement.json"
        if os.path.isfile(fallback):
            blueprint = fallback
        else:
            assemble_local_track(corpus, master_out, target_length_sec=180.0, max_slices=64)
            print(f"[STAGED] {master_out}")
            return master_out

    assemble_from_blueprint(blueprint, corpus, master_out)
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
