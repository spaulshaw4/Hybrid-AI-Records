"""Batch-write 7 Reaper envelopes per track from stem_activity_log.csv."""

from __future__ import annotations

import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.export_reaper_envelope import (
    _append_ramped_points,
    _load_timeline_rows,
    build_reaper_envelope_chunk,
)

EXCLUDED_FOLDERS = {
    "dsd100",
    "harmonic",
    "logs",
    "checkpoints",
    "temp",
    "corrupt_dsp",
}

PAN_LAYOUT = {
    "bass": 0.0,
    "beats": 0.0,
    "voice": 0.0,
    "acoustic": -0.65,
    "electric": 0.65,
    "idle": 0.0,
}

BUSES = ["acoustic", "voice", "electric", "beats", "bass"]


def process_track_envelopes(csv_path, output_dir=None, ramp_sec=0.05, filter_bus="bass"):
    """
    Parses a single track's stem_activity_log.csv and writes:
      1. volume_gate.env   (<VOLENV> RMS silence gate)
      2. pan_auto.env      (<PANENV> dynamic weighted stereo pan)
      3. send_{1..5}.env   (<AUXVOLENV> continuous multi-bus aux sends)
    """
    if not os.path.exists(csv_path):
        return False, 0

    if output_dir is None:
        output_dir = os.path.dirname(csv_path)
    os.makedirs(output_dir, exist_ok=True)

    rows = _load_timeline_rows(csv_path, filter_bus=filter_bus)
    if not rows:
        return False, 0

    vol_pts: list[tuple[float, float]] = []
    pan_pts: list[tuple[float, float]] = []
    send_pts: dict[str, list[tuple[float, float]]] = {b: [] for b in BUSES}

    for i, row in enumerate(rows):
        t_start = float(row["start_time_sec"])
        t_end = float(row["end_time_sec"])
        is_silent = str(row.get("is_silent", "")).strip().lower() == "true"

        v_gain = 0.0 if is_silent else 1.0
        if is_silent:
            p_val = 0.0
        else:
            weighted = sum(
                float(row.get(f"prob_{b}", 0.0) or 0.0) * PAN_LAYOUT.get(b, 0.0)
                for b in BUSES
            )
            p_val = max(-1.0, min(1.0, weighted))
        s_gains = {
            b: (0.0 if is_silent else float(row.get(f"prob_{b}", 0.0) or 0.0))
            for b in BUSES
        }

        _append_ramped_points(vol_pts, i, t_start, t_end, v_gain, ramp_sec)
        _append_ramped_points(pan_pts, i, t_start, t_end, p_val, ramp_sec)
        for b in BUSES:
            _append_ramped_points(
                send_pts[b], i, t_start, t_end, s_gains[b], ramp_sec
            )

    with open(os.path.join(output_dir, "volume_gate.env"), "w", encoding="utf-8") as f:
        f.write(build_reaper_envelope_chunk("VOLENV", vol_pts))
    with open(os.path.join(output_dir, "pan_auto.env"), "w", encoding="utf-8") as f:
        f.write(build_reaper_envelope_chunk("PANENV", pan_pts))
    for idx, b in enumerate(BUSES, start=1):
        path = os.path.join(output_dir, f"send_{idx}_{b}_volume.env")
        with open(path, "w", encoding="utf-8") as f:
            f.write(build_reaper_envelope_chunk("AUXVOLENV", send_pts[b]))

    return True, len(rows)


def run_batch_envelope_export(root_staging_dir):
    track_dirs = [
        os.path.join(root_staging_dir, d)
        for d in os.listdir(root_staging_dir)
        if os.path.isdir(os.path.join(root_staging_dir, d))
        and d.lower() not in EXCLUDED_FOLDERS
    ]

    print(f"\n[BATCH ENVELOPE EXPORT] Scanning {len(track_dirs)} track directories...")
    print(f"{'Track Directory':<45} | {'Slices':<8} | {'Status'}")
    print("-" * 65)

    exported_count = 0
    for t_dir in sorted(track_dirs):
        csv_file = os.path.join(t_dir, "stem_activity_log.csv")
        env_subfolder = os.path.join(t_dir, "reaper_envelopes")
        success, slice_count = process_track_envelopes(
            csv_file, output_dir=env_subfolder
        )
        track_name = os.path.basename(t_dir)
        if success:
            print(f"{track_name:<45} | {slice_count:<8} | 7 ENVELOPES CREATED")
            exported_count += 1
        else:
            print(f"{track_name:<45} | {'0':<8} | SKIPPED (No CSV)")

    print("-" * 65)
    print(
        f"[COMPLETE] Generated 7 DAW automation envelopes for {exported_count} tracks."
    )
    return exported_count


if __name__ == "__main__":
    staging_root = r"C:\staging_slices"
    run_batch_envelope_export(staging_root)
