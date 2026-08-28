import os
import glob
import json
import numpy as np
import soundfile as sf
import librosa
from pathlib import Path
from tqdm import tqdm

GENRE_MAP = {
    "heavy_rock": ["rock", "metal", "heavy", "grunge"],
    "nu_metal": ["nu-metal", "drop-d", "distorted"],
    "rap_rock": ["rap", "crossover", "boom"],
    "cinematic": ["cinematic", "orchestral", "strings"],
    "trap": ["trap", "808", "drill"],
    "industrial": ["industrial", "abrasive", "machine"],
    "acoustic": ["acoustic", "unplugged"]
}


class HybridEngineSlicer:
    def __init__(self, target_sr=44100):
        self.target_sr = target_sr

    def _infer_genre(self, filepath):
        name_lower = filepath.lower()
        for genre, keywords in GENRE_MAP.items():
            if any(k in name_lower for k in keywords):
                return genre
        return "general"

    def _snap_zero_crossing(self, mono, sample_idx, radius=512):
        left = max(0, sample_idx - radius)
        right = min(len(mono), sample_idx + radius)
        zero_crossings = np.where(np.diff(np.sign(mono[left:right])))[0]
        if len(zero_crossings) > 0:
            return left + zero_crossings[np.argmin(np.abs(zero_crossings - radius))]
        return sample_idx

    def _apply_anti_click(self, audio, fade_samples=220):
        if audio.shape[-1] <= fade_samples * 2:
            return audio
        fade_in = np.linspace(0, 1, fade_samples)
        fade_out = np.linspace(1, 0, fade_samples)
        clean = audio.copy()
        if clean.ndim > 1:
            clean[:, :fade_samples] *= fade_in
            clean[:, -fade_samples:] *= fade_out
        else:
            clean[:fade_samples] *= fade_in
            clean[-fade_samples:] *= fade_out
        return clean

    def _classify_role(self, mono):
        centroid = np.mean(librosa.feature.spectral_centroid(y=mono, sr=self.target_sr))
        if centroid < 250:
            return "bass_engine"
        elif centroid < 800:
            return "percussion_kick"
        elif 900 <= centroid <= 2800:
            return "snare_clap"
        elif centroid > 4500:
            return "top_end_fx"
        else:
            return "mid_melody"

    def slice_file(self, file_path, output_base):
        try:
            y, sr = librosa.load(file_path, sr=self.target_sr, mono=False)
        except Exception:
            return []

        y_mono = librosa.to_mono(y) if y.ndim > 1 else y
        stem_name = Path(file_path).stem
        genre = self._infer_genre(file_path)

        tempo, beat_frames = librosa.beat.beat_track(y=y_mono, sr=sr, start_bpm=118.0)
        bpm = max(60.0, min(180.0, float(np.atleast_1d(tempo)[0])))
        beat_samples = librosa.frames_to_samples(beat_frames)

        manifest = []
        step = 8

        if len(beat_samples) >= step:
            for idx, i in enumerate(range(0, len(beat_samples) - step, step)):
                start = self._snap_zero_crossing(y_mono, beat_samples[i])
                end = self._snap_zero_crossing(y_mono, beat_samples[i + step])
                chunk = y[:, start:end] if y.ndim > 1 else y[start:end]
                clean_chunk = self._apply_anti_click(chunk)
                role = self._classify_role(y_mono[start:end])

                out_dir = os.path.join(output_base, genre, role)
                os.makedirs(out_dir, exist_ok=True)

                filename = f"{genre}_{role}_{int(bpm)}BPM_{stem_name}_{idx:03d}.wav"
                out_path = os.path.join(out_dir, filename)
                sf.write(out_path, clean_chunk.T if clean_chunk.ndim > 1 else clean_chunk, sr)

                manifest.append({
                    "type": "loop_segment",
                    "genre": genre,
                    "engine_role": role,
                    "target_bpm": round(bpm, 2),
                    "file_path": str(out_path),
                    "duration_sec": round(clean_chunk.shape[-1] / sr, 3)
                })

        return manifest

    def process_all(self, input_dir, output_dir, manifest_path):
        all_files = []
        for ext in ("*.wav", "*.flac", "*.mp3", "*.aiff"):
            all_files.extend(glob.glob(os.path.join(input_dir, "**", ext), recursive=True))

        engine_manifest = []
        for file in tqdm(all_files, desc="Formatting for Hybrid Engine"):
            records = self.slice_file(file, output_dir)
            engine_manifest.extend(records)

        with open(manifest_path, "w") as f:
            json.dump(engine_manifest, f, indent=2)


if __name__ == "__main__":
    slicer = HybridEngineSlicer()
    slicer.process_all(
        input_dir=r"D:\MusicDatasets\curated_vault\TEST_FOLDER",
        output_dir=r"D:\MusicDatasets\engine_audio_vault",
        manifest_path=r"D:\MusicDatasets\hybrid_engine_manifest.json"
    )
