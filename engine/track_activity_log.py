"""Map locked 4s slices to a chronological stem-activity log."""

from __future__ import annotations

import csv
import glob
import json
import os
import re
import sys
from datetime import timedelta

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.engine_stem_classifier import LABELS, EngineStemClassifier

BUS_ORDER = list(LABELS)


def format_timestamp(seconds: float) -> str:
    """Converts seconds into MM:SS format."""
    td = timedelta(seconds=int(seconds))
    minutes, secs = divmod(td.seconds, 60)
    return f"{minutes:02d}:{secs:02d}"


def extract_slice_idx(filepath: str) -> int:
    match = re.search(r"_s4_(\d+)_", os.path.basename(filepath))
    return int(match.group(1)) if match else -1


def _prob_dict(probs) -> dict[str, float]:
    values = [float(x) for x in list(probs)]
    if len(values) < len(BUS_ORDER):
        values.extend([0.0] * (len(BUS_ORDER) - len(values)))
    return {bus: values[i] for i, bus in enumerate(BUS_ORDER)}


def process_track_activity_log(
    track_dir: str,
    slice_duration: float = 4.0,
    checkpoint: str = "models/checkpoints/stem_classifier_latest.pt",
    bus_filter: str | None = None,
):
    engine = EngineStemClassifier(checkpoint, smooth_window=1)

    wav_files = glob.glob(os.path.join(track_dir, "*.wav"))

    stems = [f for f in wav_files if extract_slice_idx(f) >= 0]
    if bus_filter:
        token = f"_{bus_filter.lower()}_locked.wav"
        stems = [f for f in stems if os.path.basename(f).lower().endswith(token)]
    stems = sorted(stems, key=lambda f: (extract_slice_idx(f), os.path.basename(f)))

    if not stems:
        print(f"No valid slice files found in {track_dir}")
        return []

    print(f"\nProcessing Stem Activity Log: {os.path.basename(os.path.normpath(track_dir))}")
    print(
        f"{'Time Range':<15} | {'Slice File':<40} | {'Status':<10} | "
        f"{'Detected':<10} | {'Confidence'}"
    )
    print("-" * 95)

    activity_log = []
    for wav_path in stems:
        slice_idx = extract_slice_idx(wav_path)
        start_time = float(slice_idx * slice_duration)
        end_time = float((slice_idx + 1) * slice_duration)
        time_str = f"{format_timestamp(start_time)} - {format_timestamp(end_time)}"

        pred = engine.predict_wav(wav_path)
        label, conf, is_silent = pred
        raw_probabilities = _prob_dict(pred.probs)

        status = "SILENT" if is_silent else "ACTIVE"
        detected_bus = "IDLE" if is_silent else label.upper()
        conf_f = 0.0 if is_silent else float(conf)
        conf_str = f"{conf_f * 100:5.1f}%" if not is_silent else "  0.0%"

        filename = os.path.basename(wav_path)
        print(
            f"{time_str:<15} | {filename:<40} | {status:<10} | "
            f"{detected_bus:<10} | {conf_str}"
        )

        activity_log.append(
            {
                "slice_index": slice_idx,
                "start_time_sec": start_time,
                "end_time_sec": end_time,
                "time_range": time_str,
                "file": filename,
                "is_silent": bool(is_silent),
                "gate_status": status,
                "predicted_bus": detected_bus,
                "confidence": conf_f,
                "raw_probabilities": raw_probabilities,
                # aliases for older consumers
                "start_time": start_time,
                "end_time": end_time,
                "silent": bool(is_silent),
                "bus": detected_bus,
            }
        )

    return activity_log


def export_activity_log_json(activity_log, output_path="stem_activity_log.json", quiet=False):
    """Exports the complete activity log structure to JSON."""
    payload = []
    for entry in activity_log:
        payload.append(
            {
                "slice_index": entry.get("slice_index", 0),
                "start_time_sec": entry.get("start_time_sec", entry.get("start_time", 0.0)),
                "end_time_sec": entry.get("end_time_sec", entry.get("end_time", 0.0)),
                "time_range": entry.get("time_range", ""),
                "file": entry.get("file", ""),
                "is_silent": bool(entry.get("is_silent", entry.get("silent", False))),
                "gate_status": entry.get("gate_status", ""),
                "predicted_bus": entry.get("predicted_bus", entry.get("bus", "IDLE")),
                "confidence": float(entry.get("confidence", 0.0)),
                "raw_probabilities": entry.get("raw_probabilities", {}),
            }
        )
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    if not quiet:
        print(f"[EXPORT] Saved structured JSON activity log to: {output_path}")


def export_activity_log_csv(activity_log, output_path="stem_activity_log.csv", quiet=False):
    """Flattens the activity log into a columnar CSV with probability columns."""
    if not activity_log:
        print("[EXPORT] Warning: Activity log is empty. Skipping CSV write.")
        return

    fieldnames = [
        "slice_index",
        "start_time_sec",
        "end_time_sec",
        "time_range",
        "file",
        "is_silent",
        "gate_status",
        "predicted_bus",
        "confidence",
        "prob_acoustic",
        "prob_voice",
        "prob_electric",
        "prob_beats",
        "prob_bass",
    ]

    rows = []
    for entry in activity_log:
        is_silent = bool(entry.get("is_silent", entry.get("silent", False)))
        row = {
            "slice_index": entry.get("slice_index", 0),
            "start_time_sec": entry.get("start_time_sec", entry.get("start_time", 0.0)),
            "end_time_sec": entry.get("end_time_sec", entry.get("end_time", 0.0)),
            "time_range": entry.get("time_range", ""),
            "file": entry.get("file", ""),
            "is_silent": is_silent,
            "gate_status": entry.get(
                "gate_status", "SILENT" if is_silent else "ACTIVE"
            ),
            "predicted_bus": entry.get("predicted_bus", entry.get("bus", "IDLE")),
            "confidence": f"{float(entry.get('confidence', 0.0)):.4f}",
        }
        raw_probs = entry.get("raw_probabilities", {})
        if isinstance(raw_probs, dict):
            for bus in BUS_ORDER:
                row[f"prob_{bus}"] = f"{float(raw_probs.get(bus, 0.0)):.4f}"
        else:
            for bus in BUS_ORDER:
                row[f"prob_{bus}"] = "0.0000"
        rows.append(row)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    if not quiet:
        print(f"[EXPORT] Saved tabular CSV activity log to: {output_path}")


# Raw dumps, incomplete trees, and non-track folders — never walk these.
EXCLUDED_FOLDERS = frozenset(
    {
        "dsd100",
        "harmonic",
        "logs",
        "checkpoints",
        "temp",
        "corrupt_dsp",
        "__pycache__",
    }
)


def process_single_track(track_dir, engine, slice_duration=4.0):
    wav_files = glob.glob(os.path.join(track_dir, "*.wav"))
    stems = sorted(
        [f for f in wav_files if extract_slice_idx(f) >= 0],
        key=lambda f: (extract_slice_idx(f), os.path.basename(f)),
    )
    if not stems:
        return []

    activity_log = []
    for wav_path in stems:
        slice_idx = extract_slice_idx(wav_path)
        start_time = slice_idx * slice_duration
        end_time = (slice_idx + 1) * slice_duration
        pred = engine.predict_wav(wav_path)
        label, conf, is_silent = pred
        raw_probabilities = dict(getattr(engine, "last_probs", {})) or _prob_dict(
            pred.probs
        )
        activity_log.append(
            {
                "slice_index": slice_idx,
                "start_time_sec": float(start_time),
                "end_time_sec": float(end_time),
                "time_range": (
                    f"{format_timestamp(start_time)} - {format_timestamp(end_time)}"
                ),
                "file": os.path.basename(wav_path),
                "is_silent": bool(is_silent),
                "gate_status": "SILENT" if is_silent else "ACTIVE",
                "predicted_bus": "IDLE" if is_silent else label.upper(),
                "confidence": 0.0 if is_silent else float(conf),
                "raw_probabilities": raw_probabilities,
            }
        )
    return activity_log


def save_reports(activity_log, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    export_activity_log_json(
        activity_log,
        os.path.join(output_dir, "stem_activity_log.json"),
        quiet=True,
    )
    export_activity_log_csv(
        activity_log,
        os.path.join(output_dir, "stem_activity_log.csv"),
        quiet=True,
    )


def run_batch_logging(
    root_staging_dir,
    checkpoint="models/checkpoints/stem_classifier_latest.pt",
    export_in_place=True,
    centralized_out_dir=None,
):
    engine = EngineStemClassifier(checkpoint, smooth_window=1)
    track_dirs = [
        os.path.join(root_staging_dir, d)
        for d in os.listdir(root_staging_dir)
        if os.path.isdir(os.path.join(root_staging_dir, d))
        and d.lower() not in EXCLUDED_FOLDERS
    ]

    print(
        f"\n[BATCH ENGINE] Found {len(track_dirs)} valid track directories "
        f"(excluded {len(EXCLUDED_FOLDERS)} patterns)"
    )
    print(f"{'Track Directory':<45} | {'Slices':<8} | {'Active':<8} | {'Status'}")
    print("-" * 75)

    summary_stats = []
    for t_dir in sorted(track_dirs):
        track_name = os.path.basename(t_dir)
        log = process_single_track(t_dir, engine)
        if not log:
            print(f"{track_name:<45} | {'0':<8} | {'0':<8} | SKIPPED (No valid slices)")
            continue

        total_slices = len(log)
        active_slices = sum(1 for item in log if not item["is_silent"])
        target_out = (
            t_dir
            if export_in_place
            else os.path.join(centralized_out_dir or root_staging_dir, "logs", track_name)
        )
        save_reports(log, target_out)
        print(f"{track_name:<45} | {total_slices:<8} | {active_slices:<8} | SAVED")
        summary_stats.append(
            {"track": track_name, "total": total_slices, "active": active_slices}
        )

    print("-" * 75)
    print(f"[COMPLETE] Processed {len(summary_stats)} active tracks.")
    return summary_stats


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--batch", "batch"):
        staging_root = r"C:\staging_slices"
        run_batch_logging(staging_root, export_in_place=True)
    else:
        track_path = r"C:\staging_slices\001 - ANiMAL - Clinic A"
        bus = sys.argv[1] if len(sys.argv) > 1 else "bass"
        log = process_track_activity_log(track_path, bus_filter=bus)
        if log:
            save_reports(log, track_path)
            active = sum(1 for row in log if not row["is_silent"])
            print(
                f"\n[LOG] {len(log)} slices | active={active} silent={len(log) - active} "
                f"| span {log[0]['time_range'].split(' - ')[0]}-"
                f"{log[-1]['time_range'].split(' - ')[-1]}"
            )

