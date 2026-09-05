"""Live circular-buffer stem router. Accepts DAW-rate chunks, infers at 22.05 kHz."""

from __future__ import annotations

import os
import sys

import numpy as np
import torch
import torchaudio
import torchaudio.transforms as T

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.engine_stem_classifier import (
    HOP_LENGTH,
    N_FFT,
    N_FRAMES,
    N_MELS,
    SAMPLE_RATE as TRAIN_SR,
    TARGET_SAMPLES,
    EngineStemClassifier,
)
from engine.soft_bus_router import SoftBusRouter


class LiveStreamRouter:
    def __init__(
        self,
        checkpoint: str = "models/checkpoints/stem_classifier_latest.pt",
        sample_rate: int = 44100,
        slice_duration: float = 4.0,
        device: str | None = None,
    ):
        self.sample_rate = int(sample_rate)
        self.window_samples = int(self.sample_rate * slice_duration)
        self.engine = EngineStemClassifier(checkpoint, device=device)
        self.router = SoftBusRouter(self.engine)
        self.model_sr = TRAIN_SR

        # Match trainer DSP (22.05 kHz / n_fft=1024 / hop=512), not raw DAW rate.
        self.mel_spectrogram = T.MelSpectrogram(
            sample_rate=self.model_sr,
            n_fft=N_FFT,
            hop_length=HOP_LENGTH,
            n_mels=N_MELS,
            power=2.0,
        ).to(self.engine.device)

        self._ring = np.zeros(self.window_samples, dtype=np.float32)
        self._write = 0
        self._filled = 0

    def push_chunk(self, audio_chunk: np.ndarray, rms_threshold_db: float = -50.0):
        """Append a chunk to the 4 s ring and classify the current window."""
        if audio_chunk.ndim > 1:
            audio_chunk = np.mean(audio_chunk, axis=0)
        chunk = np.asarray(audio_chunk, dtype=np.float32).reshape(-1)
        n = chunk.shape[0]
        if n == 0:
            return self.router.silent_matrix()

        if n >= self.window_samples:
            self._ring[:] = chunk[-self.window_samples :]
            self._write = 0
            self._filled = self.window_samples
        else:
            end = self._write + n
            if end <= self.window_samples:
                self._ring[self._write : end] = chunk
            else:
                first = self.window_samples - self._write
                self._ring[self._write :] = chunk[:first]
                self._ring[: n - first] = chunk[first:]
            self._write = (self._write + n) % self.window_samples
            self._filled = min(self.window_samples, self._filled + n)

        if self._filled < self.window_samples:
            return self.router.silent_matrix()

        # Unwrap so sample 0 is the oldest.
        window = np.concatenate(
            (self._ring[self._write :], self._ring[: self._write])
        )
        return self.process_buffer(window, rms_threshold_db=rms_threshold_db)

    def process_buffer(
        self,
        audio_chunk: np.ndarray,
        rms_threshold_db: float = -50.0,
    ):
        """
        Processes a raw float32 NumPy audio chunk of shape (N,) or (channels, N).
        Returns routing mode, linear bus gains, and decibel sends.
        """
        if audio_chunk.ndim > 1:
            audio_chunk = np.mean(audio_chunk, axis=0)
        audio_chunk = np.asarray(audio_chunk, dtype=np.float32).reshape(-1)

        if len(audio_chunk) < self.window_samples:
            audio_chunk = np.pad(
                audio_chunk, (0, self.window_samples - len(audio_chunk))
            )
        else:
            audio_chunk = audio_chunk[: self.window_samples]

        rms = np.sqrt(np.mean(audio_chunk**2) + 1e-12)
        rms_db = 20 * np.log10(rms)
        if rms_db < rms_threshold_db:
            return self.router.silent_matrix()

        tensor = torch.from_numpy(np.ascontiguousarray(audio_chunk)).float()
        if int(self.sample_rate) != int(self.model_sr):
            tensor = torchaudio.functional.resample(
                tensor, self.sample_rate, self.model_sr
            )
        if tensor.numel() < TARGET_SAMPLES:
            tensor = torch.nn.functional.pad(
                tensor, (0, TARGET_SAMPLES - tensor.numel())
            )
        else:
            tensor = tensor[:TARGET_SAMPLES]
        tensor = tensor.unsqueeze(0).to(self.engine.device)

        with torch.no_grad():
            mel_spec = self.mel_spectrogram(tensor)
            log_mel = torch.log(torch.clamp(mel_spec, min=1e-5))
            t = log_mel.shape[-1]
            if t < N_FRAMES:
                log_mel = torch.nn.functional.pad(log_mel, (0, N_FRAMES - t))
            elif t > N_FRAMES:
                log_mel = log_mel[..., :N_FRAMES]
            log_mel = log_mel.unsqueeze(0)
            logits = self.engine.model(log_mel)
            probs = torch.softmax(logits, dim=1).detach().cpu().numpy()[0]

        self.engine.last_probs = {
            b: float(probs[i]) for i, b in enumerate(self.router.buses)
        }
        conf = float(np.max(probs))
        label = self.router.buses[int(np.argmax(probs))]
        return self.router.calculate_routing_matrix_from_probs(label, conf)


if __name__ == "__main__":
    import torchaudio as ta

    router = LiveStreamRouter()
    wav = r"C:\staging_slices\001 - ANiMAL - Clinic A\bass_s4_00002_bass_locked.wav"
    waveform, sr = ta.load(wav)
    chunk = waveform.mean(dim=0).numpy()
    if int(sr) != 44100:
        chunk_t = torch.from_numpy(chunk).float()
        chunk = torchaudio.functional.resample(chunk_t, int(sr), 44100).numpy()
    mode, linear, dbs = router.process_buffer(chunk)
    print("process_buffer", mode, {k: round(v, 3) for k, v in linear.items()})
    mode2, linear2, _ = router.push_chunk(chunk[: 44100])  # 1s, ring not full
    print("push_chunk 1s", mode2)
    mode3, linear3, _ = router.push_chunk(chunk)
    print("push_chunk 4s", mode3, {k: round(v, 3) for k, v in linear3.items()})
