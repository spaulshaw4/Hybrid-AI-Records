import os
import argparse
from pydub import AudioSegment


def sum_buses(session_id, work_dir):
    print("\n================================================================")
    print(f"BUS SUMMATION - MASTERING 7-MINUTE TRACK: {session_id}")
    print("================================================================")

    raw_dir = os.path.join(work_dir, "raw_stems")
    master_out = os.path.join(work_dir, f"{session_id}_master.wav")

    if not os.path.exists(raw_dir):
        raise FileNotFoundError(f"Missing stems directory: {raw_dir}")

    stem_files = sorted([f for f in os.listdir(raw_dir) if f.endswith(".wav")])
    total_stems = len(stem_files)

    print(f"[SUMMATION] Found {total_stems} stems to process.")

    if total_stems == 0:
        print("[ERROR] No valid .wav files found to sum.")
        return

    # Initialize master track with the first stem
    master_path = os.path.join(raw_dir, stem_files[0])
    master_track = AudioSegment.from_file(master_path, format="wav")

    # Overlay remaining stems in sequential batches
    for i in range(1, total_stems):
        filepath = os.path.join(raw_dir, stem_files[i])
        stem = AudioSegment.from_file(filepath, format="wav")
        master_track = master_track.overlay(stem)

        if i % 50 == 0 or i == total_stems - 1:
            print(f"  -> [SUMMATION] Processed {i + 1}/{total_stems} stems...")

    master_track.export(master_out, format="wav")
    print(f"[SUCCESS] Full 7-minute master track rendered: {master_out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()

    sum_buses(args.session, args.dir)
