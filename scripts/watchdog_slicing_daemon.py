# D:\MusicDatasets\scripts\watchdog_slicing_daemon.py
import os
import time
import shutil
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from pydub import AudioSegment

BASE_DIR = r"D:\MusicDatasets"
INCOMING_DIR = os.path.join(BASE_DIR, "incoming")
UPLOADED_SLICES_DIR = os.path.join(BASE_DIR, "uploaded_slices")
ARCHIVE_DIR = os.path.join(BASE_DIR, "archive")

SLICE_DURATION_MS = 1000  # 1000ms target slice length


class AudioIngestionHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return

        file_path = event.src_path
        file_ext = os.path.splitext(file_path)[1].lower()

        if file_ext not in [".wav", ".mp3", ".flac", ".ogg"]:
            return

        # Allow time for file write/copy operations to fully complete
        time.sleep(1.5)
        self.process_audio(file_path)

    def process_audio(self, file_path):
        try:
            filename = os.path.basename(file_path)

            # Determine genre lock from parent directory name
            parent_dir = os.path.basename(os.path.dirname(file_path))
            genre = parent_dir if parent_dir != "incoming" else "heavy_alternative_rock"

            target_slice_dir = os.path.join(UPLOADED_SLICES_DIR, genre)
            os.makedirs(target_slice_dir, exist_ok=True)
            os.makedirs(ARCHIVE_DIR, exist_ok=True)

            print(f"\n[WATCHDOG] Ingesting audio file: {filename} (Genre: {genre})")

            audio = AudioSegment.from_file(file_path)
            total_duration_ms = len(audio)
            total_slices = total_duration_ms // SLICE_DURATION_MS

            if total_slices == 0:
                print(f"[WATCHDOG] File {filename} shorter than {SLICE_DURATION_MS}ms. Skipping.")
                return

            print(f"[WATCHDOG] Slicing into {total_slices} discrete 1000ms chunks...")

            base_name = os.path.splitext(filename)[0]
            timestamp = int(time.time())

            for idx in range(total_slices):
                start_ms = idx * SLICE_DURATION_MS
                end_ms = start_ms + SLICE_DURATION_MS
                slice_chunk = audio[start_ms:end_ms]

                slice_filename = f"slice_{genre}_{timestamp}_{idx:04d}.wav"
                slice_path = os.path.join(target_slice_dir, slice_filename)
                slice_chunk.export(slice_path, format="wav")

            print(f"[SUCCESS] Exported {total_slices} slices to {target_slice_dir}")

            # Move original file to archive
            archive_target = os.path.join(ARCHIVE_DIR, f"{timestamp}_{filename}")
            shutil.move(file_path, archive_target)
            print(f"[WATCHDOG] Archived source file to {archive_target}")

        except Exception as e:
            print(f"[WATCHDOG ERROR] Failed to process {file_path}: {e}")


def start_watchdog():
    os.makedirs(INCOMING_DIR, exist_ok=True)
    os.makedirs(UPLOADED_SLICES_DIR, exist_ok=True)
    os.makedirs(ARCHIVE_DIR, exist_ok=True)

    print("================================================================")
    print("HYBRID 1.0 - AUDIO INGESTION & 1000MS SLICING WATCHDOG")
    print(f"Monitoring: {INCOMING_DIR}")
    print("================================================================")

    event_handler = AudioIngestionHandler()
    observer = Observer()
    observer.schedule(event_handler, path=INCOMING_DIR, recursive=True)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()

    observer.join()


if __name__ == "__main__":
    start_watchdog()
