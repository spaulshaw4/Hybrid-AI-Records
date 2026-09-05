"""Single-command stem classify + envelope + Reaper session assembly."""

from __future__ import annotations

import argparse
import csv
import glob
import os
import sys

REPO = os.path.abspath(os.path.dirname(__file__))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.batch_export_reaper_envelopes import process_track_envelopes
from engine.engine_stem_classifier import EngineStemClassifier
from engine.generate_reaper_project import create_reaper_project_advanced
from engine.soft_bus_router import SoftBusRouter
from engine.track_activity_log import extract_slice_idx, format_timestamp

EXCLUDED_FOLDERS = {
    "dsd100",
    "harmonic",
    "logs",
    "checkpoints",
    "temp",
    "corrupt_dsp",
    "reaper_envelopes",
}

AUDIO_GLOBS = ("*.wav", "*.flac", "*.mp3", "*.ogg", "*.aiff", "*.aif")


def _list_audio(track_dir: str) -> list[str]:
    files: list[str] = []
    for pattern in AUDIO_GLOBS:
        files.extend(glob.glob(os.path.join(track_dir, pattern)))
    files = [f for f in files if extract_slice_idx(f) >= 0 or os.path.splitext(f)[1].lower() != ".wav"]
    locked = [f for f in files if extract_slice_idx(f) >= 0]
    if locked:
        files = locked
    return sorted(files, key=lambda p: (extract_slice_idx(p), os.path.basename(p)))


def process_single_session(track_dir, classifier, router, export_rpp=True):
    print(f"\n[PROCESSING] -> {os.path.basename(track_dir)}")
    csv_log_path = os.path.join(track_dir, "stem_activity_log.csv")
    env_dir = os.path.join(track_dir, "reaper_envelopes")
    wavs = _list_audio(track_dir)

    if not wavs:
        print(f"  [WARN] No audio files found in {track_dir}")
        return False

    records = []
    for fallback_idx, path in enumerate(wavs):
        pred = classifier.predict_wav(path)
        label, conf, is_silent = pred
        slice_idx = extract_slice_idx(path)
        if slice_idx < 0:
            slice_idx = fallback_idx
        t_start = float(slice_idx * 4.0)
        t_end = t_start + 4.0
        detected = "IDLE" if is_silent else str(label).upper()
        row = {
            "slice_index": slice_idx,
            "start_time_sec": f"{t_start:.1f}",
            "end_time_sec": f"{t_end:.1f}",
            "time_range": f"{format_timestamp(t_start)} - {format_timestamp(t_end)}",
            "file": os.path.basename(path),
            "is_silent": bool(is_silent),
            "gate_status": "SILENT" if is_silent else "ACTIVE",
            "predicted_bus": detected,
            "confidence": f"{(0.0 if is_silent else float(conf)):.4f}",
        }
        for bus in classifier.buses:
            row[f"prob_{bus}"] = f"{classifier.last_probs.get(bus, 0.0):.4f}"
        records.append(row)

    os.makedirs(env_dir, exist_ok=True)
    headers = list(records[0].keys())
    with open(csv_log_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(records)
    print(f"  [CSV] Activity log saved ({len(records)} slices).")

    process_track_envelopes(csv_log_path, output_dir=env_dir)
    print("  [ENV] Generated 7 DAW automation envelopes.")

    if export_rpp:
        rpp_file = create_reaper_project_advanced(track_dir)
        print(f"  [RPP] Assembled DAW Session: {os.path.basename(rpp_file)}")

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Hybrid AI Stem Classification & DAW Assembly Engine"
    )
    parser.add_argument(
        "--input",
        "-i",
        required=True,
        help="Path to track folder or root staging directory",
    )
    parser.add_argument(
        "--checkpoint",
        "-c",
        default=None,
        help="Path to .pt model weights",
    )
    parser.add_argument(
        "--device",
        "-d",
        default="cpu",
        choices=["cuda", "cpu"],
        help="Inference device (cpu keeps the MX450 free for the trainer)",
    )
    parser.add_argument(
        "--no-rpp",
        action="store_true",
        help="Skip .rpp Reaper project assembly",
    )
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"[ERROR] Target path does not exist: {args.input}")
        sys.exit(1)

    print("[INITIALIZING] Loading neural classification engine...")
    classifier = EngineStemClassifier(
        checkpoint_path=args.checkpoint,
        device=args.device,
        smooth_window=1,
    )
    router = SoftBusRouter(classifier)

    child_dirs = [
        os.path.join(args.input, name)
        for name in os.listdir(args.input)
        if os.path.isdir(os.path.join(args.input, name))
        and name.lower() not in EXCLUDED_FOLDERS
    ]
    has_audio_directly = bool(_list_audio(args.input))

    if has_audio_directly or not child_dirs:
        process_single_session(
            args.input, classifier, router, export_rpp=not args.no_rpp
        )
    else:
        print(f"[BATCH] Found {len(child_dirs)} session folders to process.")
        for directory in sorted(child_dirs):
            process_single_session(
                directory, classifier, router, export_rpp=not args.no_rpp
            )

    print("\n[COMPLETE] All operations finished successfully.")


if __name__ == "__main__":
    main()
