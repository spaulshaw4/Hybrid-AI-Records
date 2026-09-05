"""CUDA + FP16 continuous trainer — NVMe staging + lazy/background RAM cache.

Bottleneck bypass stack:
  1. Prefer ``C:\\staging_slices`` (NVMe) over ``D:\\...\\corpus_4s_dsp_locked``
  2. Background thread pre-fills the RAM mel cache ahead of the train loop
  3. DataLoader pin_memory; workers stay 0 on Windows (shared in-process cache)
  4. Mini-pool: first N epochs train on the first 25k slices while the cache grows

Schema: ``reports/dataset_manifest.sqlite`` / table ``manifest``.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import threading
import time

os.environ.setdefault("OMP_NUM_THREADS", "6")
os.environ.setdefault("MKL_NUM_THREADS", "6")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "6")

import torch
import torch.nn as nn
import torch.optim as optim
import torchaudio
import torchaudio.transforms as T
from torch.utils.data import DataLoader, Dataset, Subset

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from scripts.build_dataset_manifest import STEM_LABEL_MAP, build_manifest

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

LOCKED_ROOT = r"D:\MusicDatasets\mtg\corpus_4s_dsp_locked"
STAGING_ROOT = r"C:\staging_slices"

BATCH_SIZE = 64
MAX_CACHE_SLICES = 250_000
EPOCHS = 100
MINI_POOL_SIZE = 25_000
MINI_EPOCHS = 5
SAMPLE_RATE = 22050
DURATION_SEC = 4.0
TARGET_SAMPLES = int(SAMPLE_RATE * DURATION_SEC)
# Windows spawn cannot share the in-process RAM cache — keep workers=0.
# NVMe staging + background cache thread replace multi-worker prefetch here.
NUM_WORKERS = 0


def resolve_audio_path(path: str) -> str:
    """Prefer the C: NVMe staging copy when robocopy has delivered it."""
    try:
        rel = os.path.relpath(path, LOCKED_ROOT)
    except ValueError:
        return path
    if rel.startswith(".."):
        return path
    staged = os.path.join(STAGING_ROOT, rel)
    if os.path.exists(staged):
        return staged
    return path


class LazyRAMDataset(Dataset):
    """Lazy + background-fillable mel cache (up to ``max_cache_slices``)."""

    def __init__(
        self,
        db_path: str,
        split: str = "train",
        max_cache_slices: int = MAX_CACHE_SLICES,
    ):
        self.db_path = db_path
        self.split = split
        self.max_cache_slices = int(max_cache_slices)
        self.cache: dict[int, tuple[torch.Tensor, torch.Tensor]] = {}
        self._cache_lock = threading.Lock()
        self.label_map = dict(STEM_LABEL_MAP)
        self.mel_transform = T.MelSpectrogram(
            sample_rate=SAMPLE_RATE,
            n_fft=1024,
            hop_length=512,
            n_mels=128,
            power=2.0,
        )
        hop = int(self.mel_transform.hop_length)
        n_fft = int(self.mel_transform.n_fft)
        # Derive exact frame count from torchaudio (formula can be off-by-1..2).
        with torch.no_grad():
            probe = self.mel_transform(torch.zeros(1, TARGET_SAMPLES))
        self.n_frames = int(probe.shape[-1])
        self.fallback = torch.zeros(1, 128, self.n_frames)
        self.records = self._load_manifest()
        staged = 0
        for p, _ in self.records:
            try:
                rel = os.path.relpath(p, LOCKED_ROOT)
            except ValueError:
                continue
            if not rel.startswith("..") and os.path.exists(
                os.path.join(STAGING_ROOT, rel)
            ):
                staged += 1
        print(
            f"[DATASET] Loaded {len(self.records):,} records | "
            f"NVMe-staged {staged:,}/{len(self.records):,}"
        )

    def _load_manifest(self) -> list[tuple[str, int]]:
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
            (self.split,),
        )
        for path, label_id in cursor.fetchall():
            records.append((path, int(label_id)))
        conn.close()
        return records

    def refresh(self) -> int:
        self.records = self._load_manifest()
        return len(self.records)

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
        mel = torch.log(torch.clamp(mel, min=1e-5))
        t = mel.shape[-1]
        if t < self.n_frames:
            mel = torch.nn.functional.pad(mel, (0, self.n_frames - t))
        elif t > self.n_frames:
            mel = mel[..., : self.n_frames]
        return mel

    def __getitem__(self, idx: int):
        with self._cache_lock:
            hit = self.cache.get(idx)
        if hit is not None:
            return hit

        file_path, label = self.records[idx]
        label_t = torch.tensor(label, dtype=torch.long)
        try:
            mel_spec = self._to_mel(resolve_audio_path(file_path))
        except Exception:
            mel_spec = self.fallback.clone()

        item = (mel_spec.detach().contiguous(), label_t)
        with self._cache_lock:
            if len(self.cache) < self.max_cache_slices and idx not in self.cache:
                self.cache[idx] = item
        return item


def background_cache_worker(dataset: LazyRAMDataset, stop_event: threading.Event) -> None:
    """Prefill RAM mel cache ahead of the training loop (daemon).

    Mini-pool indices are filled first so Epoch 1–5 hit RAM quickly. A short
    sleep between loads yields the GIL so the train loop is not starved.
    """
    print("[CACHE] Background ingestion thread started", flush=True)
    n = len(dataset.records)
    pool = min(MINI_POOL_SIZE, n)
    order = list(range(pool)) + list(range(pool, n))
    for scan_i, idx in enumerate(order, 1):
        if stop_event.is_set():
            break
        with dataset._cache_lock:
            full = len(dataset.cache) >= dataset.max_cache_slices
            missing = idx not in dataset.cache
        if full:
            break
        if missing:
            try:
                _ = dataset[idx]
            except Exception:
                pass
        # Yield so CUDA train batches can interleave on the GIL.
        time.sleep(0.02)
        if scan_i % 2000 == 0:
            with dataset._cache_lock:
                cached = len(dataset.cache)
            print(
                f"[CACHE] Background filled {cached:,}/{dataset.max_cache_slices:,} "
                f"(scan {scan_i:,}/{n:,})",
                flush=True,
            )
    with dataset._cache_lock:
        cached = len(dataset.cache)
    print(f"[CACHE] Background ingestion done | cached={cached:,}", flush=True)


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


def make_loader(dataset: Dataset, shuffle: bool = True) -> DataLoader:
    kwargs = dict(
        batch_size=BATCH_SIZE,
        shuffle=shuffle,
        num_workers=NUM_WORKERS,
        pin_memory=(DEVICE.type == "cuda"),
        drop_last=True,
    )
    # persistent_workers / prefetch_factor require num_workers > 0.
    if NUM_WORKERS > 0:
        kwargs["persistent_workers"] = True
        kwargs["prefetch_factor"] = 4
    return DataLoader(dataset, **kwargs)


def run_epoch(
    epoch: int,
    model: nn.Module,
    optimizer: optim.Optimizer,
    criterion: nn.Module,
    scaler: torch.amp.GradScaler,
    train_loader: DataLoader,
    dataset: LazyRAMDataset,
) -> float:
    model.train()
    running_loss = 0.0
    start_time = time.time()
    last_loss = 0.0

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

        last_loss = float(loss.item())
        running_loss += last_loss

        if batch_idx % 5 == 0 or batch_idx == len(train_loader):
            n = 5 if batch_idx % 5 == 0 else (batch_idx % 5 or 1)
            avg_loss = running_loss / max(1, n)
            elapsed = time.time() - start_time
            sec_per_batch = elapsed / max(1, n)
            vram = (
                torch.cuda.memory_allocated(0) / (1024**2)
                if DEVICE.type == "cuda"
                else 0.0
            )
            with dataset._cache_lock:
                cached = len(dataset.cache)
            print(
                f"[Epoch {epoch} | Batch {batch_idx}/{len(train_loader)}] "
                f"Loss: {avg_loss:.4f} | Pace: {sec_per_batch:.2f}s/batch | "
                f"VRAM: {vram:.1f}MB | "
                f"RAM Cached: {cached:,} slices",
                flush=True,
            )
            running_loss = 0.0
            start_time = time.time()

    return last_loss


def run_training() -> None:
    if DEVICE.type == "cuda":
        torch.backends.cudnn.benchmark = True
        props = torch.cuda.get_device_properties(0)
        print(
            f"[INIT] VRAM total={props.total_memory / (1024**3):.2f} GB | "
            f"AMP=FP16 | batch={BATCH_SIZE} | staging={STAGING_ROOT}"
        )

    if not os.path.isdir(STAGING_ROOT):
        print(
            f"[WARN] Staging dir missing ({STAGING_ROOT}). "
            "Start robocopy to NVMe for full speed; falling back to D:.",
            flush=True,
        )

    # Skip full D: re-index on startup while robocopy + lock contend for the
    # USB disk; use the existing SQLite ledger and refresh between epochs.
    if os.path.exists(DB_PATH):
        print(
            f"[INIT] Using existing manifest at {DB_PATH} "
            "(defer re-index until between epochs)",
            flush=True,
        )
    else:
        build_manifest()

    dataset = LazyRAMDataset(db_path=DB_PATH, split="train")
    if len(dataset) == 0:
        print("[INIT] Manifest empty — building once before train", flush=True)
        build_manifest()
        dataset = LazyRAMDataset(db_path=DB_PATH, split="train")
    if len(dataset) == 0:
        raise SystemExit(
            f"No train rows in {DB_PATH}. Is the lock job writing slices?"
        )

    # Prime the mini-pool in-process before Epoch 1 so the first batches
    # are not stuck behind cold D: seeks (background thread continues after).
    pool_n = min(MINI_POOL_SIZE, len(dataset))
    prime_n = min(512, pool_n)  # ~8 batches worth
    print(f"[CACHE] Priming mini-pool head ({prime_n:,} slices)...", flush=True)
    for i in range(prime_n):
        try:
            _ = dataset[i]
        except Exception:
            pass
    print(
        f"[CACHE] Primed {len(dataset.cache):,} | launching background fill",
        flush=True,
    )

    stop_event = threading.Event()
    cache_thread = threading.Thread(
        target=background_cache_worker,
        args=(dataset, stop_event),
        daemon=True,
        name="mel-cache-worker",
    )
    cache_thread.start()

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

    print(
        f"[START] Mini-pool {pool_n:,} slices x {MINI_EPOCHS} epochs, "
        f"then full corpus | background cache active",
        flush=True,
    )

    # --- Strategy 4: fast mini-pool epochs while cache / staging catch up ---
    mini_epochs_done = 0
    if start_epoch <= MINI_EPOCHS:
        mini = Subset(dataset, list(range(pool_n)))
        # Sequential order so primed head + background fill stay ahead of reads.
        mini_loader = make_loader(mini, shuffle=False)
        for epoch in range(start_epoch, MINI_EPOCHS + 1):
            loss = run_epoch(
                epoch, model, optimizer, criterion, scaler, mini_loader, dataset
            )
            mini_epochs_done = epoch
            ckpt_path = os.path.join(
                CHECKPOINT_DIR, f"stem_classifier_epoch_{epoch}.pt"
            )
            payload = {
                "epoch": epoch,
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "scaler_state": scaler.state_dict() if scaler.is_enabled() else None,
                "loss": loss,
                "phase": "mini_pool",
            }
            torch.save(payload, ckpt_path)
            torch.save(payload, LATEST_CKPT)
            print(f"[CHECKPOINT] Saved: {ckpt_path} (mini-pool)", flush=True)
        start_epoch = max(start_epoch, MINI_EPOCHS + 1)

    print(
        f"[START] Full training on {len(dataset):,} slices "
        f"(from epoch {start_epoch})...",
        flush=True,
    )

    for epoch in range(start_epoch, EPOCHS + 1):
        if epoch > start_epoch or mini_epochs_done:
            build_manifest()
            n = dataset.refresh()
            print(f"[EPOCH {epoch}] Manifest refresh -> {n:,} train slices", flush=True)

        train_loader = make_loader(dataset)
        loss = run_epoch(
            epoch, model, optimizer, criterion, scaler, train_loader, dataset
        )

        ckpt_path = os.path.join(
            CHECKPOINT_DIR, f"stem_classifier_epoch_{epoch}.pt"
        )
        payload = {
            "epoch": epoch,
            "model_state_dict": model.state_dict(),
            "optimizer_state_dict": optimizer.state_dict(),
            "scaler_state": scaler.state_dict() if scaler.is_enabled() else None,
            "loss": loss,
            "phase": "full",
        }
        torch.save(payload, ckpt_path)
        torch.save(payload, LATEST_CKPT)
        print(f"[CHECKPOINT] Saved: {ckpt_path}", flush=True)

    stop_event.set()


if __name__ == "__main__":
    run_training()
