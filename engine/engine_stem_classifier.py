"""Runtime stem-bus classifier for locked 4s slices.

Uses the same ``StemClassifier`` weights as ``scripts/continuous_train_cuda.py``
(not the residual ``AudioStemClassifier`` in ``models/stem_classifier.py``).
"""

from __future__ import annotations

import os
import sys
from collections import deque

import numpy as np
import torch
import torch.nn as nn
import torchaudio
import torchaudio.transforms as T

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

CHECKPOINT_DIR = os.path.join(REPO, "models", "checkpoints")
DEFAULT_RELEASE = os.path.join(
    REPO, "models", "release", "stem_classifier_v1.0.0.pt"
)
DEFAULT_LATEST = DEFAULT_RELEASE
LABELS = ("acoustic", "voice", "electric", "beats", "bass")


class WavPrediction:
    """Unpacks as ``label, conf, is_silent``; ``.probs`` is the softmax."""

    __slots__ = ("label", "confidence", "silent", "probs")

    def __init__(
        self,
        label: str,
        confidence: float,
        silent: bool,
        probs: np.ndarray,
    ):
        self.label = label
        self.confidence = confidence
        self.silent = silent
        self.probs = probs

    def __iter__(self):
        yield self.label
        yield self.confidence
        yield self.silent

SAMPLE_RATE = 22050
DURATION_SEC = 4.0
TARGET_SAMPLES = int(SAMPLE_RATE * DURATION_SEC)
N_MELS = 128
N_FFT = 1024
HOP_LENGTH = 512

_MEL_TRANSFORM = T.MelSpectrogram(
    sample_rate=SAMPLE_RATE,
    n_fft=N_FFT,
    hop_length=HOP_LENGTH,
    n_mels=N_MELS,
    power=2.0,
)
with torch.no_grad():
    N_FRAMES = int(_MEL_TRANSFORM(torch.zeros(1, TARGET_SAMPLES)).shape[-1])


class StemClassifier(nn.Module):
    """Live CUDA-trainer architecture. Checkpoint keys: features.*, classifier.*"""

    def __init__(self, num_classes: int = 5):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=3, stride=1, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(32, 64, kernel_size=3, stride=1, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(64, 128, kernel_size=3, stride=1, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((4, 4)),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(128 * 4 * 4, 256),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(256, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.classifier(self.features(x))


# Alias for the name used in the engine sketch.
StemClassifierNet = StemClassifier


def resolve_checkpoint_path(checkpoint_path: str) -> str:
    """Accept short names like ``epoch_7.pt`` / ``latest.pt`` or a full path."""
    if checkpoint_path and os.path.isfile(checkpoint_path):
        return checkpoint_path

    name = os.path.basename(checkpoint_path or "")
    aliases = {
        "v1.0.0.pt": "stem_classifier_v1.0.0.pt",
        "learning.pt": "stem_classifier_learning.pt",
        "latest.pt": "stem_classifier_latest.pt",
        "epoch_10.pt": "stem_classifier_epoch_10.pt",
        "epoch_9.pt": "stem_classifier_epoch_9.pt",
        "epoch_8.pt": "stem_classifier_epoch_8.pt",
        "epoch_7.pt": "stem_classifier_epoch_7.pt",
        "epoch_6.pt": "stem_classifier_epoch_6.pt",
        "epoch_5.pt": "stem_classifier_epoch_5.pt",
    }
    candidates = []
    if name in aliases:
        candidates.append(os.path.join(CHECKPOINT_DIR, aliases[name]))
    if name:
        candidates.append(os.path.join(CHECKPOINT_DIR, name))
        if not name.startswith("stem_classifier_"):
            candidates.append(os.path.join(CHECKPOINT_DIR, f"stem_classifier_{name}"))
    candidates.append(DEFAULT_RELEASE)
    candidates.append(os.path.join(CHECKPOINT_DIR, "stem_classifier_latest.pt"))

    for path in candidates:
        if path and os.path.isfile(path):
            return path
    raise FileNotFoundError(
        f"No checkpoint for {checkpoint_path!r}. "
        f"Looked at {DEFAULT_RELEASE} and {CHECKPOINT_DIR}"
    )


def load_audio_file(file_path: str) -> tuple[torch.Tensor, int]:
    """Load wav/flac/mp3/aiff (and 24-bit PCM) as ``(channels, time)`` float32."""
    try:
        waveform, sr = torchaudio.load(file_path)
        return waveform.float(), int(sr)
    except Exception:
        try:
            import soundfile as sf
        except ImportError as exc:
            raise RuntimeError(
                f"Could not load {file_path}. Install soundfile for FLAC/MP3 fallback."
            ) from exc
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
        return torch.from_numpy(np.ascontiguousarray(data.T)), int(sr)


def normalize_waveform(
    waveform: torch.Tensor | np.ndarray,
    sample_rate: int,
    target_sr: int = SAMPLE_RATE,
    duration_sec: float = DURATION_SEC,
) -> torch.Tensor:
    """Mono downmix, resample to ``target_sr``, pad/trim to ``duration_sec``."""
    if not torch.is_tensor(waveform):
        waveform = torch.as_tensor(np.asarray(waveform), dtype=torch.float32)
    waveform = waveform.detach().float().cpu()
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0)
    elif waveform.ndim >= 3:
        waveform = waveform.reshape(waveform.shape[-2], waveform.shape[-1])
    if waveform.shape[0] > waveform.shape[1] and waveform.shape[1] <= 16:
        waveform = waveform.transpose(0, 1)
    if waveform.shape[0] > 1:
        waveform = torch.mean(waveform, dim=0, keepdim=True)

    src_sr = int(sample_rate)
    dst_sr = int(target_sr)
    if src_sr != dst_sr:
        waveform = torchaudio.functional.resample(waveform, src_sr, dst_sr)

    target_len = int(dst_sr * duration_sec)
    n = int(waveform.shape[-1])
    if n < target_len:
        waveform = torch.nn.functional.pad(waveform, (0, target_len - n))
    else:
        waveform = waveform[..., :target_len]
    return waveform


def load_mono_waveform(
    wav_path: str,
    target_sample_rate: int = SAMPLE_RATE,
) -> torch.Tensor:
    """Load any supported audio as mono, resampled, padded/trimmed to 4 s."""
    waveform, sr = load_audio_file(wav_path)
    return normalize_waveform(waveform, sr, target_sr=target_sample_rate)


def is_active_audio(waveform: torch.Tensor, threshold_db: float = -50.0) -> bool:
    """Returns True if slice RMS energy is above the noise floor."""
    rms = torch.sqrt(torch.mean(waveform ** 2))
    if rms <= 0:
        return False
    db = 20 * torch.log10(rms)
    return db.item() > threshold_db


def waveform_rms_db(waveform: torch.Tensor) -> float:
    rms = torch.sqrt(torch.mean(waveform ** 2))
    if float(rms) <= 0:
        return float("-inf")
    return float((20 * torch.log10(rms)).item())


def load_and_preprocess_slice(
    wav_path: str,
    target_sample_rate: int = SAMPLE_RATE,
    n_mels: int = N_MELS,
    n_fft: int = N_FFT,
    hop_length: int = HOP_LENGTH,
    n_frames: int = N_FRAMES,
) -> torch.Tensor:
    """WAV -> log-mel ``(1, n_mels, n_frames)`` matching the CUDA trainer."""
    waveform = load_mono_waveform(wav_path, target_sample_rate=target_sample_rate)

    if (
        target_sample_rate == SAMPLE_RATE
        and n_mels == N_MELS
        and n_fft == N_FFT
        and hop_length == HOP_LENGTH
    ):
        mel_transform = _MEL_TRANSFORM
    else:
        mel_transform = T.MelSpectrogram(
            sample_rate=target_sample_rate,
            n_fft=n_fft,
            hop_length=hop_length,
            n_mels=n_mels,
            power=2.0,
        )

    mel_spec = mel_transform(waveform)
    log_mel = torch.log(torch.clamp(mel_spec, min=1e-5))

    if log_mel.shape[-1] > n_frames:
        log_mel = log_mel[..., :n_frames]
    elif log_mel.shape[-1] < n_frames:
        log_mel = torch.nn.functional.pad(
            log_mel, (0, n_frames - log_mel.shape[-1])
        )
    return log_mel


class EngineStemClassifier:
    def __init__(
        self,
        checkpoint_path: str | None = None,
        device: str | None = None,
        smooth_window: int = 4,
        target_sr: int = SAMPLE_RATE,
        n_mels: int = N_MELS,
        n_fft: int = N_FFT,
        hop_length: int = HOP_LENGTH,
    ):
        if checkpoint_path is None:
            checkpoint_path = DEFAULT_LATEST
        if device is None:
            env = (os.environ.get("HYBRID_INFER_DEVICE") or "cpu").strip().lower()
            device = env if env in {"cpu", "cuda"} else "cpu"
            if device == "cuda" and not torch.cuda.is_available():
                device = "cpu"
        self.device = torch.device(device)
        self.target_sr = int(target_sr)
        self.n_mels = int(n_mels)
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.labels = list(LABELS)
        self.buses = list(LABELS)
        self.smooth_window = int(smooth_window)
        self.history: deque[np.ndarray] = deque(maxlen=self.smooth_window)
        self.mel_transform = T.MelSpectrogram(
            sample_rate=self.target_sr,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            n_mels=self.n_mels,
            power=2.0,
        ).to(self.device)
        with torch.no_grad():
            probe = torch.zeros(
                1, int(self.target_sr * DURATION_SEC), device=self.device
            )
            self.n_frames = int(self.mel_transform(probe).shape[-1])
        self.checkpoint_path = resolve_checkpoint_path(checkpoint_path)
        self.last_loaded_mtime = 0.0
        self.last_probs: dict[str, float] = {name: 0.0 for name in LABELS}
        self.model: StemClassifierNet | None = None
        self.loaded_epoch = None
        self.loaded_phase = None
        if not self.reload_if_updated():
            raise FileNotFoundError(
                f"No checkpoint at {self.checkpoint_path}"
            )

    def reload_if_updated(self) -> bool:
        """Hot-swap weights when the pinned production file is newer.

        Safe if the trainer is mid-write: a failed load keeps the old net and
        retries on the next check. Call between tracks or on a 60s timer.
        """
        path = self.checkpoint_path
        if not os.path.isfile(path):
            return False

        current_mtime = os.path.getmtime(path)
        if current_mtime <= self.last_loaded_mtime:
            return False

        print(
            f"\n[ENGINE] New checkpoint detected! Hot-reloading weights from {path}...",
            flush=True,
        )
        try:
            checkpoint = torch.load(
                path, map_location=self.device, weights_only=False
            )
        except Exception as exc:
            print(f"[ENGINE] Hot-reload skipped (file busy?): {exc}", flush=True)
            return False

        state_dict = (
            checkpoint["model_state_dict"]
            if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint
            else checkpoint
        )

        if self.model is None:
            self.model = StemClassifierNet(num_classes=5).to(self.device)

        try:
            self.model.load_state_dict(state_dict)
        except Exception as exc:
            print(f"[ENGINE] Hot-reload skipped (bad weights): {exc}", flush=True)
            return False

        self.model.eval()
        self.last_loaded_mtime = current_mtime
        self.loaded_epoch = (
            checkpoint.get("epoch") if isinstance(checkpoint, dict) else None
        )
        self.loaded_phase = (
            checkpoint.get("phase") if isinstance(checkpoint, dict) else None
        )
        self.reset_history()
        print(
            f"[ENGINE] Checkpoint hot-swap complete. "
            f"epoch={self.loaded_epoch} phase={self.loaded_phase}",
            flush=True,
        )
        return True

    def reset_history(self) -> None:
        self.history.clear()

    @torch.no_grad()
    def predict_slice(self, mel_spec_tensor: torch.Tensor):
        """
        Input: Tensor shaped (1, n_mels, time_steps) e.g. (1, 128, 171)
               or already batched (1, 1, 128, T).
        Returns: (predicted_label, smoothed_confidence, raw_smoothed_probs)
        """
        x = mel_spec_tensor
        if x.dim() == 3:
            x = x.unsqueeze(0)
        elif x.dim() == 2:
            x = x.unsqueeze(0).unsqueeze(0)
        x = x.to(self.device)
        if self.model is None:
            raise RuntimeError("Model not loaded — call reload_if_updated() first")

        logits = self.model(x)
        probs = torch.softmax(logits, dim=1).squeeze(0).detach().cpu().numpy()

        self.history.append(probs)
        smoothed_probs = sum(self.history) / len(self.history)

        best_idx = int(smoothed_probs.argmax())
        return self.labels[best_idx], float(smoothed_probs[best_idx]), smoothed_probs

    @torch.no_grad()
    def predict_audio_tensor(
        self,
        waveform: torch.Tensor,
        sample_rate: int,
        rms_thresh_db: float = -50.0,
    ):
        """Normalize rate/channels/length, then classify.

        Returns ``WavPrediction`` (unpacks as label, conf, is_silent).
        Silent frames are ``idle`` / 0% and skip the ConvNet.
        """
        self.reload_if_updated()
        waveform = normalize_waveform(
            waveform, sample_rate, target_sr=self.target_sr
        )
        if not is_active_audio(waveform, threshold_db=rms_thresh_db):
            zeros = np.zeros(len(self.labels), dtype=np.float64)
            self.last_probs = {name: 0.0 for name in self.labels}
            return WavPrediction(
                label="idle",
                confidence=0.0,
                silent=True,
                probs=zeros,
            )

        waveform = waveform.to(self.device)
        mel_spec = self.mel_transform(waveform)
        log_mel = torch.log(torch.clamp(mel_spec, min=1e-5))
        t = int(log_mel.shape[-1])
        if t < self.n_frames:
            log_mel = torch.nn.functional.pad(log_mel, (0, self.n_frames - t))
        elif t > self.n_frames:
            log_mel = log_mel[..., : self.n_frames]
        label, conf, probs = self.predict_slice(log_mel)
        self.last_probs = {
            name: float(probs[i]) for i, name in enumerate(self.labels)
        }
        return WavPrediction(
            label=label, confidence=conf, silent=False, probs=probs
        )

    @torch.no_grad()
    def predict_wav(
        self,
        wav_path: str,
        skip_silent: bool = True,
        threshold_db: float = -50.0,
        rms_thresh_db: float | None = None,
    ):
        """Classify wav/flac/mp3/aiff. Returns ``WavPrediction``."""
        thresh = threshold_db if rms_thresh_db is None else rms_thresh_db
        waveform, sr = load_audio_file(wav_path)
        pred = self.predict_audio_tensor(waveform, sr, rms_thresh_db=thresh)
        if skip_silent or pred.silent:
            return pred
        return pred


class DynamicEngineStemClassifier(EngineStemClassifier):
    """Live loop that tracks ``stem_classifier_v1.0.0.pt`` and hot-swaps epochs."""

    def __init__(
        self,
        checkpoint_path: str = DEFAULT_LATEST,
        device: str | None = None,
        smooth_window: int = 4,
    ):
        super().__init__(
            checkpoint_path=checkpoint_path,
            device=device,
            smooth_window=smooth_window,
        )


if __name__ == "__main__":
    engine = EngineStemClassifier(
        "models/checkpoints/stem_classifier_latest.pt",
        smooth_window=1,
    )
    base_dir = r"C:\staging_slices\001 - ANiMAL - Clinic A"
    slices = [
        os.path.join(base_dir, f"bass_s4_{i:05d}_bass_locked.wav") for i in range(5)
    ]
    print(f"{'Slice':<28} | {'Gate Status':<18} | {'Class':<10} | {'Confidence':<10}")
    print("-" * 76)
    for wav_path in slices:
        if not os.path.exists(wav_path):
            print(f"{os.path.basename(wav_path):<28} | NOT FOUND")
            continue
        label, conf, is_silent = engine.predict_wav(wav_path)
        gate_state = "SILENCE (< -50dB)" if is_silent else "ACTIVE AUDIO"
        print(
            f"{os.path.basename(wav_path):<28} | {gate_state:<18} | "
            f"{label.upper():<10} | {conf * 100:5.1f}%"
        )
