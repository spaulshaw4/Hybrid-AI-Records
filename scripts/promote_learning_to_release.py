"""Promote finished GPU epochs onto the live production checkpoint.

The CUDA trainer writes ``models/checkpoints/stem_classifier_learning.pt``
(or ``stem_classifier_latest.pt`` while the current process is still running).
This watcher waits until that file is stable, then atomically replaces
``models/release/stem_classifier_v1.0.0.pt`` so the CPU live engine can
hot-swap without touching the GPU file.
"""

from __future__ import annotations

import os
import shutil
import sys
import time

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ.setdefault("HYBRID_INFER_DEVICE", "cpu")

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CHECKPOINT_DIR = os.path.join(REPO, "models", "checkpoints")
RELEASE_DIR = os.path.join(REPO, "models", "release")
RELEASE_CKPT = os.path.join(RELEASE_DIR, "stem_classifier_v1.0.0.pt")
LEARNING_CKPT = os.path.join(CHECKPOINT_DIR, "stem_classifier_learning.pt")
LATEST_CKPT = os.path.join(CHECKPOINT_DIR, "stem_classifier_latest.pt")
STATE_PATH = os.path.join(REPO, "reports", "promoted_release.state")
POLL_SEC = 15.0
STABLE_SEC = 2.0


def _log(msg: str) -> None:
    print(f"[PROMOTE] {msg}", flush=True)


def _stat(path: str) -> tuple[float, int] | None:
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_mtime, info.st_size)


def _stable_source() -> tuple[str, float, int] | None:
    for path in (LEARNING_CKPT, LATEST_CKPT):
        first = _stat(path)
        if first is None:
            continue
        time.sleep(STABLE_SEC)
        second = _stat(path)
        if second is None or second != first:
            return None
        return (path, second[0], second[1])
    return None


def _read_state() -> tuple[str, float, int] | None:
    if not os.path.isfile(STATE_PATH):
        return None
    try:
        raw = open(STATE_PATH, encoding="utf-8").read().strip()
        path, mtime, size = raw.split("|", 2)
        return (path, float(mtime), int(size))
    except (OSError, ValueError):
        return None


def _write_state(path: str, mtime: float, size: int) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="ascii") as handle:
        handle.write(f"{path}|{mtime}|{size}\n")
    os.replace(tmp, STATE_PATH)


def promote(src: str) -> None:
    os.makedirs(RELEASE_DIR, exist_ok=True)
    tmp = RELEASE_CKPT + ".tmp"
    shutil.copy2(src, tmp)
    os.replace(tmp, RELEASE_CKPT)
    _log(f"Hot-swap ready -> {RELEASE_CKPT} (from {os.path.basename(src)})")


def loop() -> None:
    last = _read_state()
    _log(
        f"Watching {os.path.basename(LEARNING_CKPT)} "
        f"(fallback {os.path.basename(LATEST_CKPT)}) every {int(POLL_SEC)}s"
    )
    while True:
        source = _stable_source()
        if source is None:
            time.sleep(POLL_SEC)
            continue
        path, mtime, size = source
        if last and last[0] == path and last[1] == mtime and last[2] == size:
            time.sleep(POLL_SEC)
            continue
        try:
            promote(path)
        except OSError as exc:
            _log(f"promote skipped: {exc}")
            time.sleep(POLL_SEC)
            continue
        last = (path, mtime, size)
        _write_state(path, mtime, size)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        loop()
    except KeyboardInterrupt:
        _log("stopped")
        raise SystemExit(0)
