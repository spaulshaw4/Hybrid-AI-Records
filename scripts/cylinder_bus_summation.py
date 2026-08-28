import os
import argparse
from pydub import AudioSegment


def sum_bus_stems(session_id, work_dir):
    print("\n================================================================")
    print(f"CYLINDER BUS SUMMATION - RENDERING MASTER FOR: {session_id}")
    print("================================================================")

    raw_stems_dir = os.path.join(work_dir, "raw_stems")
    if not os.path.exists(raw_stems_dir):
        raise FileNotFoundError(f"Raw stems directory not found at: {raw_stems_dir}")

    stem_files = sorted([f for f in os.listdir(raw_stems_dir) if f.endswith(".wav")])

    if not stem_files:
        raise ValueError(f"No stem files found in {raw_stems_dir}")

    print(f"[SUMMATION] Loading and summing {len(stem_files)} sequential stems...")

    # Initialize master mix container
    master_mix = AudioSegment.empty()

    for idx, stem_file in enumerate(stem_files):
        stem_path = os.path.join(raw_stems_dir, stem_file)
        segment = AudioSegment.from_file(stem_path)
        master_mix += segment

        if (idx + 1) % 50 == 0:
            print(f"  -> Summed {idx + 1}/{len(stem_files)} stems...")

    master_output_path = os.path.join(work_dir, "master_output.wav")
    print(f"[SUMMATION] Exporting final summed master to {master_output_path}...")
    master_mix.export(master_output_path, format="wav")

    print(f"[SUCCESS] Cylinder bus summation complete. Master track rendered ({len(master_mix) // 1000}s).")
    return master_output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cylinder Bus Summation Engine")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory path")
    args = parser.parse_args()

    sum_bus_stems(args.session, args.dir)
