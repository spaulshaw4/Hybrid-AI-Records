import os
import time
import shutil
from pydub import AudioSegment
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

INCOMING_DIR = r"D:\MusicDatasets\incoming"
SLICES_DIR = r"D:\MusicDatasets\uploaded_slices"
ARCHIVE_DIR = r"D:\MusicDatasets\archive"


class AudioIngestHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return

        file_path = event.src_path
        if not file_path.lower().endswith(('.wav', '.mp3', '.flac', '.ogg')):
            return

        # Give a brief moment for the file write operation to finish completely
        time.sleep(1.5)

        print(f"\n[WATCHDOG] Detected new audio file: {file_path}")
        self.process_file(file_path)

    def process_file(self, file_path):
        rel_path = os.path.relpath(file_path, INCOMING_DIR)
        path_parts = rel_path.split(os.sep)

        # Determine genre folder from path structure
        genre = path_parts[0] if len(path_parts) > 1 else "unknown"
        filename = path_parts[-1]

        genre_slices_path = os.path.join(SLICES_DIR, genre)
        genre_archive_path = os.path.join(ARCHIVE_DIR, genre)

        os.makedirs(genre_slices_path, exist_ok=True)
        os.makedirs(genre_archive_path, exist_ok=True)

        base_name = os.path.splitext(filename)[0]

        try:
            print(f"  -> Loading and slicing: {filename} under genre [{genre}]")
            audio = AudioSegment.from_file(file_path)

            chunk_length_ms = 1000
            chunks = len(audio) // chunk_length_ms

            slice_count = 0
            for i in range(chunks):
                start_ms = i * chunk_length_ms
                end_ms = start_ms + chunk_length_ms
                chunk = audio[start_ms:end_ms]

                if chunk.dBFS < -50:
                    continue

                slice_filename = f"{base_name}_s{i:04d}.wav"
                slice_output_path = os.path.join(genre_slices_path, slice_filename)
                chunk.export(slice_output_path, format="wav")
                slice_count += 1

            archive_path = os.path.join(genre_archive_path, filename)
            shutil.move(file_path, archive_path)
            print(f"  -> [SUCCESS] Exported {slice_count} clean 1000ms slices. Archived source to {archive_path}")

        except Exception as e:
            print(f"  -> [ERROR] Failed processing {filename}: {e}")


if __name__ == "__main__":
    if not os.path.exists(INCOMING_DIR):
        os.makedirs(INCOMING_DIR, exist_ok=True)

    print("================================================================")
    print("HYBRID 1.0 - WATCHDOG FILE-WATCHER SLICING DAEMON")
    print(f"Monitoring: {INCOMING_DIR}")
    print("================================================================")

    event_handler = AudioIngestHandler()
    observer = Observer()
    observer.schedule(event_handler, path=INCOMING_DIR, recursive=True)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        print("\nWatchdog daemon stopped.")
    observer.join()
