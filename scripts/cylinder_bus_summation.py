import os
import argparse
from pydub import AudioSegment


def sum_stems_to_master(session_id, work_dir):
    print("\n================================================================")
    print(f"BUS SUMMATION ENGINE - RENDERING MASTER TRACK FOR: {session_id}")
    print("================================================================")

    raw_stems_dir = os.path.join(work_dir, "raw_stems")
    if not os.path.exists(raw_stems_dir):
        raise FileNotFoundError(f"Raw stems directory not found: {raw_stems_dir}")

    stem_files = sorted([f for f in os.listdir(raw_stems_dir) if f.startswith("stem_") and f.endswith(".wav")])

    if not stem_files:
        raise ValueError(f"No valid stems found in {raw_stems_dir}")

    print(f"[SUMMATION] Found {len(stem_files)} stems. Stitching 7-minute master track...")

    master_audio = AudioSegment.empty()
    for idx, filename in enumerate(stem_files):
        stem_path = os.path.join(raw_stems_dir, filename)
        chunk = AudioSegment.from_file(stem_path, format="wav")
        master_audio += chunk

        if (idx + 1) % 50 == 0:
            print(f"  -> Merged {idx + 1}/{len(stem_files)} segments...")

    master_output_path = os.path.join(work_dir, "master_output.wav")
    master_audio.export(master_output_path, format="wav")

    print(f"[SUCCESS] Master track successfully rendered to: {master_output_path}")
    print(f"Total Duration: {len(master_audio) / 1000.0:.2f} seconds")
    return master_output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Bus Summation Engine")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory path")
    args = parser.parse_args()

    sum_stems_to_master(args.session, args.dir)
