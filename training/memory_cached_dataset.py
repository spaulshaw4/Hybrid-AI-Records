"""In-RAM mel cache dataset targeting ~22–24 GB on a 32 GB host.

Designed for single-process DataLoader use (``num_workers=0``). Windows
spawn workers each get an empty cache copy, so parallel workers defeat the
RAM-buffer goal.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Optional

import torch
from torch.utils.data import Dataset

try:
    import torchaudio
    import torchaudio.transforms as T
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "torchaudio is required for training.memory_cached_dataset"
    ) from exc

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_DB = os.path.join(REPO, "reports", "dataset_manifest.sqlite")

# 4s @ 22.05 kHz, n_fft=1024, hop=512 → ~171 frames; float32 mel ≈ 85 KB.
# 250k × 85 KB ≈ 21.3 GB — fits a ~24 GB RAM budget on a 32 GB machine.
DEFAULT_SAMPLE_RATE = 22050
DEFAULT_MAX_CACHE_SLICES = 250_000


class MemoryCachedDataset(Dataset):
    """Manifest-backed dataset with an optional in-process mel RAM cache."""

    def __init__(
        self,
        db_path: str = DEFAULT_DB,
        split: str = "train",
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        duration_sec: float = 4.0,
        max_cache_slices: int = DEFAULT_MAX_CACHE_SLICES,
        n_fft: int = 1024,
        hop_length: int = 512,
        n_mels: int = 128,
    ):
        self.sample_rate = int(sample_rate)
        self.target_samples = int(self.sample_rate * duration_sec)
        self.max_cache_slices = int(max_cache_slices)
        self.cache: dict[int, tuple[torch.Tensor, torch.Tensor]] = {}

        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT slice_path, label_id FROM manifest WHERE split_group = ?",
            (split,),
        )
        self.records = cursor.fetchall()
        conn.close()

        self.mel_transform = T.MelSpectrogram(
            sample_rate=self.sample_rate,
            n_fft=n_fft,
            hop_length=hop_length,
            n_mels=n_mels,
            power=2.0,
        )
        # Approximate time frames for fallback / byte estimates.
        self._n_frames = (
            max(1, (self.target_samples - n_fft) // hop_length + 1)
        )
        self._fallback = torch.zeros(1, n_mels, self._n_frames)

    def __len__(self) -> int:
        return len(self.records)

    @property
    def cache_bytes_est(self) -> int:
        per = 1 * 128 * self._n_frames * 4
        return len(self.cache) * per

    def _load_mel(self, file_path: str) -> torch.Tensor:
        waveform, sr = torchaudio.load(file_path)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if int(sr) != self.sample_rate:
            waveform = torchaudio.functional.resample(
                waveform, int(sr), self.sample_rate
            )
        n = waveform.shape[-1]
        if n < self.target_samples:
            waveform = torch.nn.functional.pad(
                waveform, (0, self.target_samples - n)
            )
        else:
            waveform = waveform[..., : self.target_samples]

        mel = self.mel_transform(waveform)
        return torch.log(torch.clamp(mel, min=1e-5))

    def __getitem__(self, idx: int):
        if idx in self.cache:
            return self.cache[idx]

        file_path, label = self.records[idx]
        label_t = torch.tensor(label, dtype=torch.long)
        try:
            mel = self._load_mel(file_path)
        except Exception:
            mel = self._fallback.clone()

        if len(self.cache) < self.max_cache_slices:
            # Detach + clone so cache owns its storage.
            self.cache[idx] = (mel.detach().contiguous(), label_t)

        return mel, label_t

    def warm_cache(
        self,
        max_slices: Optional[int] = None,
        log_every: int = 5000,
    ) -> int:
        """Eagerly fill the RAM buffer (call from the training process)."""
        limit = self.max_cache_slices if max_slices is None else int(max_slices)
        limit = min(limit, len(self.records), self.max_cache_slices)
        print(
            f"[*] Warming mel cache: target={limit:,} slices "
            f"(~{limit * 1 * 128 * self._n_frames * 4 / (1024 ** 3):.1f} GB est.)"
        )
        for i in range(limit):
            if i not in self.cache:
                _ = self[i]
            if (i + 1) % log_every == 0 or (i + 1) == limit:
                gb = self.cache_bytes_est / (1024 ** 3)
                print(
                    f"[*] Cache {i + 1:,}/{limit:,} "
                    f"({100.0 * (i + 1) / limit:.1f}%) | ~{gb:.2f} GB"
                )
        return len(self.cache)
