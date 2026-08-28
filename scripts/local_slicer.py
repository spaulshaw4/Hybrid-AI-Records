import os
import shutil
from pydub import AudioSegment

INCOMING_DIR = r"D:\MusicDatasets\incoming"
SLICES_DIR = r"D:\MusicDatasets\uploaded_slices"
ARCHIVE_DIR = r"D:\MusicDatasets\archive"


def ingest_and_slice_audio():
    print("================================================================")
    print("DATASET INGESTION & 1000MS SLICING ENGINE")
    print("================================================================")

    if not os.path.exists(INCOMING_DIR):
        os.makedirs(INCOMING_DIR)
        print(f"[SETUP] Created incoming watch directory at {INCOMING_DIR}")
        print("Drop raw audio files (wav, mp3, flac) into genre subfolders inside incoming/ (e.g., incoming/heavy_alternative_rock/)")
        return

    genres = [d for d in os.listdir(INCOMING_DIR) if os.path.isdir(os.path.join(INCOMING_DIR, d))]

    if not genres:
        print(f"[INFO] No genre subfolders found in {INCOMING_DIR}. Waiting for ingestion assets...")
        return

    for genre in genres:
        genre_incoming_path = os.path.join(INCOMING_DIR, genre)
        genre_slices_path = os.path.join(SLICES_DIR, genre)
        genre_archive_path = os.path.join(ARCHIVE_DIR, genre)

        os.makedirs(genre_slices_path, exist_ok=True)
        os.makedirs(genre_archive_path, exist_ok=True)

        audio_files = [f for f in os.listdir(genre_incoming_path) if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg'))]

        if not audio_files:
            continue

        print(f"\n[INGEST] Processing genre group: {genre} ({len(audio_files)} files found)")

        for filename in audio_files:
            file_path = os.path.join(genre_incoming_path, filename)
            base_name = os.path.splitext(filename)[0]

            try:
                print(f"  -> Loading and slicing: {filename}")
                audio = AudioSegment.from_file(file_path)

                # 1000ms (1 second) chunk resolution
                chunk_length_ms = 1000
                chunks = len(audio) // chunk_length_ms

                slice_count = 0
                for i in range(chunks):
                    start_ms = i * chunk_length_ms
                    end_ms = start_ms + chunk_length_ms
                    chunk = audio[start_ms:end_ms]

                    # Skip silent or near-silent slices to maintain signal quality
                    if chunk.dBFS < -50:
                        continue

                    slice_filename = f"{base_name}_s{i:04d}.wav"
                    slice_output_path = os.path.join(genre_slices_path, slice_filename)
                    chunk.export(slice_output_path, format="wav")
                    slice_count += 1

                # Move original file to archive
                archive_path = os.path.join(genre_archive_path, filename)
                shutil.move(file_path, archive_path)
                print(f"  -> [SUCCESS] Exported {slice_count} clean 1000ms slices. Archived source to {archive_path}")

            except Exception as e:
                print(f"  -> [ERROR] Failed processing {filename}: {e}")


if __name__ == "__main__":
    ingest_and_slice_audio()
