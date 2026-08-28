import os
import json
import numpy as np
import soundfile as sf
import librosa
from pathlib import Path


class LocalSlicer:
    def __init__(self, target_sr=44100):
        self.target_sr = target_sr

    def _snap_zero_crossing(self, mono, idx, radius=512):
        left = max(0, idx - radius)
        right = min(len(mono), idx + radius)
        crossings = np.where(np.diff(np.sign(mono[left:right])))[0]
        return left + crossings[np.argmin(np.abs(crossings - radius))] if len(crossings) > 0 else idx

    def _apply_micro_fades(self, audio, fade_len=220):
        if audio.shape[-1] <= fade_len * 2:
            return audio
        fade_in = np.linspace(0, 1, fade_len)
        fade_out = np.linspace(1, 0, fade_len)
        out = audio.copy()
        if out.ndim > 1:
            out[:, :fade_len] *= fade_in
            out[:, -fade_len:] *= fade_out
        else:
            out[:fade_len] *= fade_in
            out[-fade_len:] *= fade_out
        return out

    def _classify_frequency_role(self, mono):
        centroid = float(np.mean(librosa.feature.spectral_centroid(y=mono, sr=self.target_sr)))
        if centroid < 300:
            return "bass"
        elif 300 <= centroid < 1800:
            return "drums"
        else:
            return "melody"

    def slice_file(self, file_path, genre, output_vault):
        y, sr = librosa.load(file_path, sr=self.target_sr, mono=False)
        y_mono = librosa.to_mono(y) if y.ndim > 1 else y

        tempo, beat_frames = librosa.beat.beat_track(y=y_mono, sr=sr, start_bpm=120.0)
        bpm = float(np.atleast_1d(tempo)[0])
        beat_samples = librosa.frames_to_samples(beat_frames)

        # Detect Root Key
        chroma = librosa.feature.chroma_cqt(y=y_mono, sr=sr)
        keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
        detected_key = keys[int(np.argmax(np.sum(chroma, axis=1)))]

        records = []
        step = 8  # 2 bars in 4/4 time

        if len(beat_samples) >= step:
            for idx, i in enumerate(range(0, len(beat_samples) - step, step)):
                start = self._snap_zero_crossing(y_mono, beat_samples[i])
                end = self._snap_zero_crossing(y_mono, beat_samples[i + step])

                chunk = y[:, start:end] if y.ndim > 1 else y[start:end]
                clean = self._apply_micro_fades(chunk)
                role = self._classify_frequency_role(y_mono[start:end])

                out_dir = os.path.join(output_vault, genre, role)
                os.makedirs(out_dir, exist_ok=True)

                stem_name = Path(file_path).stem
                filename = f"{genre}_{role}_{detected_key}_{int(bpm)}BPM_{stem_name}_{idx:03d}.wav"
                out_path = os.path.join(out_dir, filename)
                sf.write(out_path, clean.T if clean.ndim > 1 else clean, sr)

                records.append({
                    "file_path": out_path,
                    "genre": genre,
                    "role": role,
                    "key": detected_key,
                    "bpm": round(bpm, 2)
                })

        return records
