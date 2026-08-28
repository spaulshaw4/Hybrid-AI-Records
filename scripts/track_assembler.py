import json
import numpy as np
import soundfile as sf
import librosa
import os


class HybridTrackAssembler:
    def __init__(self, manifest_path, target_sr=44100):
        self.target_sr = target_sr
        with open(manifest_path, 'r') as f:
            self.vault_db = json.load(f)

    def _query_vault(self, genre, role, bpm):
        """Finds the closest matching audio slice in the vault."""
        candidates = [c for c in self.vault_db if c['genre'] == genre and c['engine_role'] == role]
        if not candidates:
            return None
        # Sort by nearest BPM to minimize time-stretching artifacts
        candidates.sort(key=lambda x: abs(x['target_bpm'] - bpm))
        return candidates[0]

    def fetch_elements(self, genre, target_bpm):
        """Fetches all matching audio elements for a genre/BPM combination."""
        elements = {}
        for role in ['percussion_kick', 'bass_engine', 'mid_melody', 'snare_clap', 'top_end_fx']:
            match = self._query_vault(genre, role, target_bpm)
            if match:
                y, sr = librosa.load(match['file_path'], sr=self.target_sr, mono=False)
                elements[role] = self._load_and_stretch_audio(y, match['target_bpm'], target_bpm)
        return elements

    def _load_and_stretch_audio(self, y, original_bpm, target_bpm):
        """Time-stretches pre-loaded audio to match target BPM."""
        if original_bpm == target_bpm:
            return y
        rate = target_bpm / original_bpm
        if y.ndim > 1:
            return np.array([librosa.effects.time_stretch(y=c, rate=rate) for c in y])
        return librosa.effects.time_stretch(y=y, rate=rate)

    def _load_and_stretch(self, file_path, original_bpm, target_bpm):
        """Loads audio and time-stretches to perfectly match the UI slider."""
        y, sr = librosa.load(file_path, sr=self.target_sr, mono=False)
        if original_bpm == target_bpm:
            return y
        rate = target_bpm / original_bpm
        if y.ndim > 1:
            return np.array([librosa.effects.time_stretch(y=c, rate=rate) for c in y])
        return librosa.effects.time_stretch(y=y, rate=rate)

    def generate_track(self, payload_path, output_dir):
        with open(payload_path, 'r') as f:
            job = json.load(f)

        print(f"Building {job['genre_lock']} track at {job['target_bpm']} BPM...")

        # 1. Select Engine Components
        drums = self._query_vault(job['genre_lock'], 'percussion_kick', job['target_bpm'])
        bass = self._query_vault(job['genre_lock'], 'bass_engine', job['target_bpm'])
        melody = self._query_vault(job['genre_lock'], 'mid_melody', job['target_bpm'])

        if not all([drums, bass, melody]):
            missing = []
            if not drums: missing.append('percussion_kick')
            if not bass: missing.append('bass_engine')
            if not melody: missing.append('mid_melody')
            print(f"Missing components for {job['genre_lock']}: {missing}")
            return None

        # 2. Process and Align Audio Arrays
        drum_audio = self._load_and_stretch(drums['file_path'], drums['target_bpm'], job['target_bpm'])
        bass_audio = self._load_and_stretch(bass['file_path'], bass['target_bpm'], job['target_bpm'])
        melody_audio = self._load_and_stretch(melody['file_path'], melody['target_bpm'], job['target_bpm'])

        # 3. Calculate Loop Multiplier for Target Length (e.g., 3:00 minutes = 180s)
        loop_duration = drum_audio.shape[-1] / self.target_sr
        repeats = int(np.ceil(job['target_length_sec'] / loop_duration))

        # 4. Construct Master Tracks
        master_drums = np.tile(drum_audio, repeats)
        master_bass = np.tile(bass_audio, repeats)
        master_melody = np.tile(melody_audio, repeats)

        # Truncate to exact UI requested length
        target_samples = int(job['target_length_sec'] * self.target_sr)
        master_drums = master_drums[..., :target_samples]
        master_bass = master_bass[..., :target_samples]
        master_melody = master_melody[..., :target_samples]

        # 5. Mixdown
        final_mix = (master_drums * 0.8) + (master_bass * 0.7) + (master_melody * 0.6)

        # Apply master limiter to prevent clipping
        max_peak = np.max(np.abs(final_mix))
        if max_peak > 1.0:
            final_mix = final_mix / max_peak

        # 6. Export to Audio Vault
        os.makedirs(output_dir, exist_ok=True)
        out_path = os.path.join(output_dir, f"{job['session_id']}_master.wav")
        sf.write(out_path, final_mix.T if final_mix.ndim > 1 else final_mix, self.target_sr)
        print(f"Track rendered to Vault: {out_path}")
        return out_path


if __name__ == "__main__":
    PAYLOAD = r"D:\MusicDatasets\current_job.json"
    MANIFEST = r"D:\MusicDatasets\hybrid_engine_manifest.json"
    VAULT_OUT = r"D:\MusicDatasets\User_Audio_Vault"

    assembler = HybridTrackAssembler(MANIFEST)
    assembler.generate_track(PAYLOAD, VAULT_OUT)
