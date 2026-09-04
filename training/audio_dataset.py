"""High-speed PyTorch Dataset over the locked DSP slice manifest.

Reads 4-second WAV chunks into fixed-length mono waveforms and returns
log-mel spectrograms (128 bins) for the residual stem classifier.
"""

from __future__ import annotations

import os
import sqlite3

import numpy as np
import soundfile as sf
import torch
from torch.utils.data import DataLoader, Dataset

try:
    import torchaudio.transforms as T
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "torchaudio is required for training.audio_dataset "
        "(pip install torchaudio)."
    ) from exc

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_DB = os.path.join(REPO, "reports", "dataset_manifest.sqlite")

# Fallback zero tensor shape: (1, n_mels, time) for 4s @ 44.1kHz, hop=512
# frames ≈ floor((176400 - 2048) / 512) + 1 = 341; use 345 as a safe pad.
FALLBACK_MEL_SHAPE = (1, 128, 345)


class AudioStemDataset(Dataset):
    def __init__(
        self,
        db_path: str = DEFAULT_DB,
        split: str = "train",
        sample_rate: int = 44100,
        duration_sec: float = 4.0,
    ):
        self.sample_rate = int(sample_rate)
        self.target_samples = int(self.sample_rate * duration_sec)

        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT slice_path, label_id FROM manifest WHERE split_group = ?",
            (split,),
        )
        self.samples = cursor.fetchall()
        conn.close()

        self.mel_transform = T.MelSpectrogram(
            sample_rate=self.sample_rate,
            n_fft=2048,
            hop_length=512,
            n_mels=128,
            power=2.0,
        )

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        file_path, label = self.samples[idx]
        label_t = torch.tensor(label, dtype=torch.long)

        try:
            audio, _sr = sf.read(file_path, dtype="float32")
            if audio.ndim > 1:
                audio = np.mean(audio, axis=1)

            if len(audio) < self.target_samples:
                pad_width = self.target_samples - len(audio)
                audio = np.pad(audio, (0, pad_width), mode="constant")
            else:
                audio = audio[: self.target_samples]

            waveform = torch.from_numpy(audio).unsqueeze(0)  # (1, N)
            mel_spec = self.mel_transform(waveform)
            log_mel = torch.log(torch.clamp(mel_spec, min=1e-5))
            return log_mel, label_t
        except Exception:
            return torch.zeros(FALLBACK_MEL_SHAPE), label_t


def get_dataloaders(
    db_path: str = DEFAULT_DB,
    batch_size: int = 64,
    num_workers: int = 4,
):
    train_ds = AudioStemDataset(db_path=db_path, split="train")
    val_ds = AudioStemDataset(db_path=db_path, split="val")

    train_loader = DataLoader(
        train_ds,
        batch_size=batch_size,
        shuffle=True,
        num_workers=num_workers,
        pin_memory=True,
        drop_last=True,
    )
    val_loader = DataLoader(
        val_ds,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        pin_memory=True,
    )
    return train_loader, val_loader
