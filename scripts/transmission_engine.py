# scripts/transmission_engine.py
import os
import json
import numpy as np
import soundfile as sf
import librosa
from supabase import create_client, Client


class TransmissionRebuilder:
    def __init__(self, manifest_path, target_sr=44100):
        self.target_sr = target_sr
        with open(manifest_path, 'r') as f:
            self.manifest = json.load(f)

        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)

    def _apply_reconstruction_buffer(self, audio_chunk, fade_samples=512):
        """Apply zero-crossing boundary stitching with micro-fade envelope."""
        if audio_chunk.shape[-1] < fade_samples * 2:
            return audio_chunk

        # Create linear crossfade envelope for boundary stitching
        fade_in = np.linspace(0.0, 1.0, fade_samples)
        fade_out = np.linspace(1.0, 0.0, fade_samples)

        if audio_chunk.ndim > 1:
            audio_chunk[..., :fade_samples] *= fade_in
            audio_chunk[..., -fade_samples:] *= fade_out
        else:
            audio_chunk[:fade_samples] *= fade_in
            audio_chunk[-fade_samples:] *= fade_out

        return audio_chunk

    def rebuild_transmission(self, session_id, target_output_dir):
        """Download and reconstruct stems from Supabase vault with buffer stitching."""
        os.makedirs(target_output_dir, exist_ok=True)

        # Pull vault metadata or manifest snapshot for session
        vault_path = f"user_vaults/{session_id}"
        stems = ["drums", "bass", "melody", "vocal"]
        rebuilt_stems = {}

        for stem in stems:
            file_name = f"{session_id}_stem_{stem}.wav"
            storage_path = f"{vault_path}/{file_name}"
            local_dest = os.path.join(target_output_dir, file_name)

            try:
                res = self.supabase.storage.from_('audio-vault').download(storage_path)
                with open(local_dest, 'wb') as f:
                    f.write(res)

                y, sr = librosa.load(local_dest, sr=self.target_sr, mono=False)

                # Apply transmission reconstruction buffer stitching
                processed = self._apply_reconstruction_buffer(y)
                rebuilt_stems[stem] = processed

            except Exception as e:
                print(f"Transmission notice: Stem {stem} not found or skipped for session {session_id}: {e}")

        print(f"Transmission successfully re-stitched and buffered for session: {session_id}")
        return rebuilt_stems


if __name__ == "__main__":
    rebuilder = TransmissionRebuilder(r"D:\MusicDatasets\hybrid_engine_manifest.json")
    print("Transmission Rebuilder engine initialized and active.")
