# scripts/master_engine.py
import os
import sys
import json
import argparse
import numpy as np
import soundfile as sf
import librosa
from supabase import create_client, Client

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402


class MasterEngine:
    def __init__(self, payload_path):
        with open(payload_path, 'r') as f:
            self.payload = json.load(f)

        self.session_id = self.payload.get("session_id")
        self.genre = self.payload.get("genre_lock", "nu_metal")
        self.target_bpm = self.payload.get("target_bpm", 118)
        self.target_length = self.payload.get("target_length_sec", 180)
        self.arrangement_tags = self.payload.get("arrangement_tags", ["verse", "chorus"])

        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)

        self.library_dir = r"D:\MusicDatasets\samples"
        self.working_dir = f"D:\\MusicDatasets\\renders\\{self.session_id}"
        os.makedirs(self.working_dir, exist_ok=True)

    def _pull_random_sample(self, category):
        """Pull a random sample from the local library by category."""
        category_path = os.path.join(self.library_dir, self.genre, category)

        if not os.path.exists(category_path):
            category_path = os.path.join(self.library_dir, "default", category)
            os.makedirs(category_path, exist_ok=True)

        files = [f for f in os.listdir(category_path) if f.endswith('.wav')]

        if not files:
            # Generate synthetic placeholder buffer if library category is empty
            sr = 44100
            t = np.linspace(0, 2, sr * 2)
            dummy = np.sin(2 * np.pi * 220 * t) * 0.5
            return dummy, sr

        selected = np.random.choice(files)
        path = os.path.join(category_path, selected)
        y, sr = librosa.load(path, sr=44100, mono=False)
        return y, sr

    def _time_stretch_and_align(self, y, orig_sr, target_bpm):
        """Transient-locked time stretching based on BPM ratio."""
        # Assuming source asset base is roughly 120 BPM if metadata is absent
        ratio = 120.0 / float(target_bpm)

        if y.ndim > 1:
            stretched_channels = [
                librosa.effects.time_stretch(y[i], rate=ratio)
                for i in range(y.shape[0])
            ]
            return np.stack(stretched_channels)
        else:
            return librosa.effects.time_stretch(y, rate=ratio)

    def assemble_tracks(self):
        """Main assembly pipeline: pull samples, stretch, concatenate, mix."""
        print(f"Master Engine: Starting procedural assembly for session {self.session_id}...")

        roles = ["percussion_kick", "bass_engine", "mid_melody", "vocal_lead"]
        stem_outputs = {}
        target_samples = self.target_length * 44100

        for role in roles:
            layered_chunks = []
            current_samples = 0

            while current_samples < target_samples:
                y, sr = self._pull_random_sample(role.split('_')[0])
                processed = self._time_stretch_and_align(y, sr, self.target_bpm)

                if processed.ndim == 1:
                    processed = np.stack([processed, processed])

                layered_chunks.append(processed)
                current_samples += processed.shape[-1]

            # Concatenate chunks and trim to exact target length
            full_stem = np.concatenate(layered_chunks, axis=-1)

            if full_stem.shape[-1] > target_samples:
                full_stem = full_stem[..., :target_samples]
            else:
                pad_amt = target_samples - full_stem.shape[-1]
                full_stem = np.pad(full_stem, ((0, 0), (0, pad_amt)), mode='constant')

            stem_filename = f"{self.session_id}_stem_{role.replace('_engine', '').replace('_lead', '')}.wav"
            local_path = os.path.join(self.working_dir, stem_filename)

            # Save 32-bit float PCM WAV
            sf.write(local_path, full_stem.T, 44100, subtype='FLOAT')
            stem_outputs[role] = local_path

        # Sum stems into Master Mix
        master_mix = np.zeros((2, target_samples))
        for role, path in stem_outputs.items():
            data, _ = sf.read(path)
            master_mix += data.T * 0.85

        master_filename = f"{self.session_id}_MASTER.wav"
        master_local_path = os.path.join(self.working_dir, master_filename)
        sf.write(master_local_path, master_mix.T, 44100, subtype='FLOAT')

        print("Master Engine: Assembly complete. Uploading stems to Supabase Cloud Vault...")
        self._upload_to_supabase(master_local_path, master_filename, stem_outputs)

    def _upload_to_supabase(self, master_path, master_filename, stem_outputs):
        """Upload all rendered stems and master to Supabase Storage."""
        vault_path = f"user_vaults/{self.session_id}"

        try:
            # Upload Master
            with open(master_path, 'rb') as f:
                self.supabase.storage.from_('audio-vault').upload(
                    f"{vault_path}/{master_filename}",
                    f,
                    file_options={"upsert": "true", "content-type": "audio/wav"}
                )

            # Upload Stems
            for role, path in stem_outputs.items():
                fname = os.path.basename(path)
                with open(path, 'rb') as f:
                    self.supabase.storage.from_('audio-vault').upload(
                        f"{vault_path}/{fname}",
                        f,
                        file_options={"upsert": "true", "content-type": "audio/wav"}
                    )

            # Update database status to completed
            self.supabase.from_('user_vaults').update({
                'status': 'completed',
                'vault_path': vault_path
            }).eq('session_id', self.session_id).execute()

            print(f"Master Engine: Session {self.session_id} successfully synced to Supabase Cloud.")

        except Exception as e:
            print(f"Master Engine Error during cloud sync: {e}")
            self.supabase.from_('user_vaults').update({
                'status': 'failed'
            }).eq('session_id', self.session_id).execute()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--payload', required=True, help='Path to job payload JSON file')
    args = parser.parse_args()

    engine = MasterEngine(args.payload)
    engine.assemble_tracks()
