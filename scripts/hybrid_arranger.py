import json
import numpy as np
import soundfile as sf
import librosa
import os


class HybridArranger:
    def __init__(self, target_sr=44100):
        self.target_sr = target_sr
        self.bar_duration = 0  # Calculated based on BPM

    def _generate_silence(self, duration_sec):
        return np.zeros(int(duration_sec * self.target_sr))

    def _crossfade_concat(self, audio_list, fade_ms=5):
        """Seamlessly joins sections without digital clicks."""
        fade_samples = int((fade_ms / 1000.0) * self.target_sr)
        if not audio_list:
            return self._generate_silence(1)

        out = audio_list[0]
        for next_audio in audio_list[1:]:
            # Simple crossfade logic for seamless transitions
            fade_out = np.linspace(1, 0, fade_samples)
            fade_in = np.linspace(0, 1, fade_samples)

            if out.ndim > 1:
                out[:, -fade_samples:] *= fade_out
                next_audio[:, :fade_samples] *= fade_in
            else:
                out[-fade_samples:] *= fade_out
                next_audio[:fade_samples] *= fade_in

            out = np.concatenate((out[..., :-fade_samples], next_audio), axis=-1)
        return out

    def build_stem_timeline(self, loop_audio, arrangement_tags, role, bpm):
        """Builds a full track stem based on UI [Verse]/[Chorus] tags."""
        self.bar_duration = (60.0 / bpm) * 4  # 1 bar in 4/4 time

        timeline = []
        for section in arrangement_tags:
            # Determine section length based on standard pop/rock structures
            bars = 8 if section in ["verse", "chorus"] else 4
            section_sec = bars * self.bar_duration

            repeats = int(np.ceil(section_sec / (loop_audio.shape[-1] / self.target_sr)))
            section_audio = np.tile(loop_audio, repeats)[..., :int(section_sec * self.target_sr)]

            # Dynamic Arrangement Logic: Drop bass in Intro/Bridge, drop drums in Outro
            if role == "bass_engine" and section in ["intro", "bridge"]:
                section_audio = section_audio * 0.0  # Mute bass
            if role == "percussion_kick" and section == "outro":
                section_audio = section_audio * 0.2  # Fade drums

            timeline.append(section_audio)

        return self._crossfade_concat(timeline)

    def render_track_and_stems(self, session_id, bpm, elements, arrangement, vault_dir):
        """Renders isolated stems and final master mix for the Audio Vault."""
        print(f"Arranging {session_id} at {bpm} BPM...")

        stems = {}
        for role, audio_data in elements.items():
            if audio_data is not None:
                stems[role] = self.build_stem_timeline(audio_data, arrangement, role, bpm)

        # Ensure all stems are the exact same length
        max_len = max([s.shape[-1] for s in stems.values()])
        for role in stems:
            if stems[role].shape[-1] < max_len:
                pad_len = max_len - stems[role].shape[-1]
                stems[role] = np.pad(
                    stems[role],
                    ((0, 0), (0, pad_len)) if stems[role].ndim > 1 else (0, pad_len)
                )

        # 1. Export Isolated Stems (For the Vault's "Export Stems" feature)
        os.makedirs(vault_dir, exist_ok=True)
        for role, audio_data in stems.items():
            stem_path = os.path.join(vault_dir, f"{session_id}_stem_{role}.wav")
            sf.write(stem_path, audio_data.T if audio_data.ndim > 1 else audio_data, self.target_sr)

        # 2. Render Final Master Mix
        master_mix = sum(stems.values())
        max_peak = np.max(np.abs(master_mix))
        if max_peak > 1.0:
            master_mix = master_mix / max_peak  # Hard limiter

        master_path = os.path.join(vault_dir, f"{session_id}_MASTER.wav")
        sf.write(master_path, master_mix.T if master_mix.ndim > 1 else master_mix, self.target_sr)

        print(f"Track rendering complete. {len(stems)} stems and Master saved to Vault.")
        return master_path


if __name__ == "__main__":
    # Example elements loaded from the query engine
    mock_audio = np.random.uniform(-0.1, 0.1, (2, 44100 * 2))
    elements = {
        "percussion_kick": mock_audio,
        "bass_engine": mock_audio,
        "mid_melody": mock_audio
    }

    tags = ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"]

    arranger = HybridArranger()
    arranger.render_track_and_stems(
        "hybrid_gen_001",
        118,
        elements,
        tags,
        r"D:\MusicDatasets\User_Audio_Vault"
    )
