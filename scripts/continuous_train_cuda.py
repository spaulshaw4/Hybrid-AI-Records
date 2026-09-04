"""CUDA + FP16 continuous trainer with ~24 GB CPU RAM mel cache.

Uses the real Forge manifest schema (``reports/dataset_manifest.sqlite``)
and keeps the DSP lock job free to keep writing slices.

Hardware profile (i7-1185G7 + GeForce MX450 2 GB):
  - 6/8 CPU threads for host-side mel / BLAS
  - CUDA + torch.amp FP16 for the CNN
  - batch=64 to stay under ~1.5 GB VRAM
  - in-process RAM cache (num_workers=0 on Windows so the cache is shared)
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time

# 75% of 8 logical cores for host-side work (mel / OpenMP).
os.environ.setdefault("OMP_NUM_THREADS", "6")
os.environ.setdefault("MKL_NUM_THREADS", "6")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "6")

import torch
import torch.nn as nn
import torch.optim as optim
import torchaudio
import torchaudio.transforms as T
from torch.utils.data import DataLoader, Dataset

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

# Prefer regenerating the stratified manifest from locked WAVs.
from scripts.build_dataset_manifest import build_manifest

torch.set_num_threads(6)
try:
    torch.set_num_interop_threads(2)
except RuntimeError:
    pass

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(
    f"[INIT] Compute Target: {DEVICE} | Active Device: "
    f"{torch.cuda.get_device_name(0) if DEVICE.type == 'cuda' else 'CPU Fallback'}"
)

DB_PATH = os.path.join(REPO, "reports", "dataset_manifest.sqlite")
CHECKPOINT_DIR = os.path.join(REPO, "models", "checkpoints")
os.makedirs(CHECKPOINT_DIR, exist_ok=True)
LATEST_CKPT = os.path.join(CHECKPOINT_DIR, "stem_classifier_latest.pt")

BATCH_SIZE = 64
MAX_CACHE_SLICES = 250_000
EPOCHS = 100
SAMPLE_RATE = 22050
DURATION_SEC = 4.0
TARGET_SAMPLES = int(SAMPLE_RATE * DURATION_SEC)
# Windows spawn cannot share an in-process cache — keep workers=0.
NUM_WORKERS = 0


class HybridRAMDataset(Dataset):
    """In-RAM mel cache (~22–24 GB at 250k slices @ 22.05 kHz)."""

    def __init__(
        self,
        db_path: str,
        split: str = "train",
        max_cache_slices: int = MAX_CACHE_SLICES,
    ):
        self.db_path = db_path
        self.max_cache_slices = int(max_cache_slices)
        self.cache: dict[int, tuple[torch.Tensor, torch.Tensor]] = {}
        self.mel_transform = T.MelSpectrogram(
            sample_rate=SAMPLE_RATE,
            n_fft=1024,
            hop_length=512,
            n_mels=128,
            power=2.0,
        )
        hop = int(self.mel_transform.hop_length)
        n_fft = int(self.mel_transform.n_fft)
        self.n_frames = int(max(1, (int(TARGET_SAMPLES) - n_fft) // hop + 1))
        self.fallback = torch.zeros(1, 128, self.n_frames)
        self.records = self._load_manifest(split)
        print(
            f"[DATASET] Loaded {len(self.records):,} records "
            f"(split={split}) from manifest."
        )

    def _load_manifest(self, split: str):
        records: list[tuple[str, int]] = []
        if not os.path.exists(self.db_path):
            return records
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT slice_path, label_id
            FROM manifest
            WHERE split_group = ? AND label_id >= 0
            """,
            (split,),
        )
        for path, label_id in cursor.fetchall():
            records.append((path, int(label_id)))
        conn.close()
        return records

    def __len__(self) -> int:
        return len(self.records)

    def _to_mel(self, file_path: str) -> torch.Tensor:
        waveform, sr = torchaudio.load(file_path)
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)
        if int(sr) != SAMPLE_RATE:
            waveform = torchaudio.functional.resample(
                waveform, int(sr), SAMPLE_RATE
            )
        n = waveform.shape[-1]
        if n < TARGET_SAMPLES:
            waveform = torch.nn.functional.pad(
                waveform, (0, TARGET_SAMPLES - n)
            )
        else:
            waveform = waveform[..., :TARGET_SAMPLES]
        mel = self.mel_transform(waveform)
        return torch.log(torch.clamp(mel, min=1e-5))

    def __getitem__(self, idx: int):
        if idx in self.cache:
            return self.cache[idx]

        file_path, label = self.records[idx]
        label_t = torch.tensor(label, dtype=torch.long)
        try:
            mel_spec = self._to_mel(file_path)
        except Exception:
            mel_spec = self.fallback.clone()

        if len(self.cache) < self.max_cache_slices:
            self.cache[idx] = (mel_spec.detach().contiguous(), label_t)
        return mel_spec, label_t

    def warm_cache(self, log_every: int = 5000) -> int:
        limit = min(self.max_cache_slices, len(self.records))
        est_gb = limit * 1 * 128 * self.n_frames * 4 / (1024**3)
        print(f"[CACHE] Warming {limit:,} slices (~{est_gb:.1f} GB est.)...")
        for i in range(limit):
            if i not in self.cache:
                _ = self[i]
            if (i + 1) % log_every == 0 or (i + 1) == limit:
                used = len(self.cache) * 1 * 128 * self.n_frames * 4 / (1024**3)
                print(
                    f"[CACHE] {i + 1:,}/{limit:,} "
                    f"({100.0 * (i + 1) / max(1, limit):.1f}%) | ~{used:.2f} GB"
                )
        return len(self.cache)


class StemClassifier(nn.Module):
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


def run_training() -> None:
    if DEVICE.type == "cuda":
        torch.backends.cudnn.benchmark = True
        props = torch.cuda.get_device_properties(0)
        print(
            f"[INIT] VRAM total={props.total_memory / (1024**3):.2f} GB | "
            f"AMP=FP16 | batch={BATCH_SIZE}"
        )

    # Refresh stratified manifest from whatever the lock job has written.
    build_manifest()

    dataset = HybridRAMDataset(db_path=DB_PATH, split="train")
    if len(dataset) == 0:
        raise SystemExit(
            f"No train rows in {DB_PATH}. Is the lock job writing slices?"
        )
    dataset.warm_cache()

    train_loader = DataLoader(
        dataset,
        batch_size=BATCH_SIZE,
        shuffle=True,
        num_workers=NUM_WORKERS,
        pin_memory=(DEVICE.type == "cuda"),
        drop_last=True,
    )

    model = StemClassifier(num_classes=5).to(DEVICE)
    optimizer = optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    criterion = nn.CrossEntropyLoss()
    scaler = torch.amp.GradScaler("cuda", enabled=(DEVICE.type == "cuda"))

    start_epoch = 1
    if os.path.exists(LATEST_CKPT):
        ckpt = torch.load(LATEST_CKPT, map_location=DEVICE, weights_only=False)
        model.load_state_dict(ckpt["model_state_dict"])
        optimizer.load_state_dict(ckpt["optimizer_state_dict"])
        if ckpt.get("scaler_state") and scaler.is_enabled():
            scaler.load_state_dict(ckpt["scaler_state"])
        start_epoch = int(ckpt.get("epoch", 0)) + 1
        print(f"[INIT] Resumed from epoch {start_epoch}")

    print(f"[START] Training on {len(dataset):,} slices across 5 buses...")

    for epoch in range(start_epoch, EPOCHS + 1):
        # Absorb newly locked files between epochs without stopping the locker.
        build_manifest()
        dataset = HybridRAMDataset(db_path=DB_PATH, split="train")
        dataset.warm_cache()
        train_loader = DataLoader(
            dataset,
            batch_size=BATCH_SIZE,
            shuffle=True,
            num_workers=NUM_WORKERS,
            pin_memory=(DEVICE.type == "cuda"),
            drop_last=True,
        )

        model.train()
        running_loss = 0.0
        start_time = time.time()

        for batch_idx, (data, target) in enumerate(train_loader, 1):
            data = data.to(DEVICE, non_blocking=True)
            target = target.to(DEVICE, non_blocking=True)

            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast(
                "cuda",
                enabled=(DEVICE.type == "cuda"),
                dtype=torch.float16,
            ):
                outputs = model(data)
                loss = criterion(outputs, target)

            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

            running_loss += float(loss.item())

            if batch_idx % 50 == 0 or batch_idx == len(train_loader):
                avg_loss = running_loss / max(1, min(50, batch_idx % 50 or 50))
                # Reset window accounting
                n = 50 if batch_idx % 50 == 0 else (batch_idx % 50)
                avg_loss = running_loss / max(1, n)
                elapsed = time.time() - start_time
                sec_per_batch = elapsed / max(1, n)
                if DEVICE.type == "cuda":
                    vram = torch.cuda.memory_allocated(0) / (1024**2)
                    print(
                        f"[Epoch {epoch} | Batch {batch_idx}/{len(train_loader)}] "
                        f"Loss: {avg_loss:.4f} | Pace: {sec_per_batch:.2f}s/batch | "
                        f"VRAM: {vram:.1f}MB"
                    )
                else:
                    print(
                        f"[Epoch {epoch} | Batch {batch_idx}/{len(train_loader)}] "
                        f"Loss: {avg_loss:.4f} | Pace: {sec_per_batch:.2f}s/batch"
                    )
                running_loss = 0.0
                start_time = time.time()

        ckpt_path = os.path.join(
            CHECKPOINT_DIR, f"stem_classifier_epoch_{epoch}.pt"
        )
        payload = {
            "epoch": epoch,
            "model_state_dict": model.state_dict(),
            "optimizer_state_dict": optimizer.state_dict(),
            "scaler_state": scaler.state_dict() if scaler.is_enabled() else None,
            "loss": float(loss.item()),
        }
        torch.save(payload, ckpt_path)
        torch.save(payload, LATEST_CKPT)
        print(f"[CHECKPOINT] Saved: {ckpt_path}")


if __name__ == "__main__":
    run_training()
