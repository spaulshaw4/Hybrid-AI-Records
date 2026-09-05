"""Build .rpp sessions for every numbered staging track."""

from __future__ import annotations

import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.generate_reaper_project import create_reaper_project

EXCLUDED_FOLDERS = {
    "dsd100",
    "harmonic",
    "logs",
    "checkpoints",
    "temp",
    "corrupt_dsp",
}


def batch_generate_projects(staging_root=r"C:\staging_slices"):
    track_dirs = [
        os.path.join(staging_root, d)
        for d in os.listdir(staging_root)
        if os.path.isdir(os.path.join(staging_root, d))
        and d.lower() not in EXCLUDED_FOLDERS
    ]

    print(f"[BATCH RPP] Generating DAW sessions for {len(track_dirs)} tracks...")
    written = 0
    for t_dir in sorted(track_dirs):
        create_reaper_project(t_dir)
        written += 1
    print(
        f"[BATCH RPP] Complete. {written} projects generated with "
        "pre-aligned envelopes and timeline slices."
    )
    return written


if __name__ == "__main__":
    batch_generate_projects()
