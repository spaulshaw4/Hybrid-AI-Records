import os
import numpy as np
import soundfile as sf
import librosa
from scipy.signal import butter, sosfilt

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


class EngineVocalProcessor:
    def __init__(self, target_sr=44100):
        self.target_sr = target_sr

    def _highpass_filter(self, y, cutoff=80.0):
        sos = butter(4, cutoff, 'hp', fs=self.target_sr, output='sos')
        return np.array([sosfilt(sos, c) for c in y]) if y.ndim > 1 else sosfilt(sos, y)

    def _apply_vocal_gate(self, y_mono, threshold_db=-42.0):
        rms = librosa.feature.rms(y=y_mono, frame_length=2048, hop_length=512)[0]
        db = librosa.amplitude_to_db(rms, ref=np.max)
        mask = np.repeat(db > threshold_db, 512)
        if len(mask) < len(y_mono):
            mask = np.pad(mask, (0, len(y_mono) - len(mask)), 'edge')
        else:
            mask = mask[:len(y_mono)]
        return mask

    def process_custom_vocal(self, vocal_input_path, output_vault_dir, session_id):
        print(f"Loading vocal take: {vocal_input_path}")
        y, sr = librosa.load(vocal_input_path, sr=self.target_sr, mono=False)

        y_filtered = self._highpass_filter(y)
        y_mono = librosa.to_mono(y_filtered) if y_filtered.ndim > 1 else y_filtered

        gate_mask = self._apply_vocal_gate(y_mono)
        y_clean = y_filtered * gate_mask

        max_val = np.max(np.abs(y_clean))
        if max_val > 0:
            target_peak = 10.0 ** (-1.0 / 20.0)
            y_clean = (y_clean / max_val) * target_peak

        chroma = librosa.feature.chroma_cqt(y=y_mono, sr=self.target_sr)
        vocal_root = NOTE_NAMES[int(np.argmax(np.sum(chroma, axis=1)))]

        os.makedirs(output_vault_dir, exist_ok=True)
        out_path = os.path.join(output_vault_dir, f"vocal_lead_{session_id}.wav")
        sf.write(out_path, y_clean.T if y_clean.ndim > 1 else y_clean, self.target_sr)

        print(f"Success! Key: {vocal_root} | Saved to: {out_path}")
        return out_path


if __name__ == "__main__":
    TEST_VOCAL = r"D:\MusicDatasets\curated_vault\TEST_FOLDER\my_raw_vocal.wav"
    OUTPUT_VAULT = r"D:\MusicDatasets\engine_audio_vault\session_vocals"

    if os.path.exists(TEST_VOCAL):
        processor = EngineVocalProcessor()
        processor.process_custom_vocal(TEST_VOCAL, OUTPUT_VAULT, "test_session_01")
    else:
        print(f"Please place a test vocal file at: {TEST_VOCAL}")
