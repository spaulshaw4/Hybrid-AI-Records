# scripts/engine_cylinders.py
import os
import json
import numpy as np
import soundfile as sf
import librosa


class EngineCylinderPipeline:
    def __init__(self, manifest_path, target_sr=44100):
        self.target_sr = target_sr
        with open(manifest_path, 'r') as f:
            self.manifest = json.load(f)

        # Define isolated processing cylinders with role-specific buffer sizes
        self.cylinders = {
            "cylinder_1_drums": {"role": "percussion", "priority": 1, "buffer_size": 256},
            "cylinder_2_bass": {"role": "low_end", "priority": 2, "buffer_size": 512},
            "cylinder_3_melody": {"role": "harmonic", "priority": 3, "buffer_size": 256},
            "cylinder_4_vocal": {"role": "lead", "priority": 4, "buffer_size": 128}
        }

    def process_cylinder(self, cylinder_id, raw_audio_path, output_path):
        """Process audio through a specific cylinder pipeline."""
        config = self.cylinders.get(cylinder_id)
        if not config:
            raise ValueError(f"Invalid cylinder identifier: {cylinder_id}")

        y, sr = librosa.load(raw_audio_path, sr=self.target_sr, mono=False)

        # Apply independent cylinder transformation logic (transient lock & zero-crossing buffer)
        processed = self._apply_cylinder_buffer(y, config["buffer_size"])

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        sf.write(
            output_path,
            processed.T if processed.ndim > 1 else processed,
            self.target_sr,
            subtype='FLOAT'
        )

        print(f"Cylinder pipeline [{cylinder_id}] executed successfully. Output saved to {output_path}")
        return output_path

    def _apply_cylinder_buffer(self, audio, buffer_size):
        """Apply cosine taper buffer at audio boundaries."""
        if audio.shape[-1] < buffer_size * 2:
            return audio

        taper = 0.5 * (1 - np.cos(np.linspace(0, np.pi, buffer_size)))

        if audio.ndim > 1:
            audio[..., :buffer_size] *= taper
            audio[..., -buffer_size:] *= taper[::-1]
        else:
            audio[:buffer_size] *= taper
            audio[-buffer_size:] *= taper[::-1]

        return audio


if __name__ == "__main__":
    pipeline = EngineCylinderPipeline(r"D:\MusicDatasets\hybrid_engine_manifest.json")
    print("Engine Cylinder Pipeline initialized and standing by for raw buffer execution.")
