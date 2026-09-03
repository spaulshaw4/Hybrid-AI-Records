"""Role-aware slice loading: rigid grid vs silence-gated phrases.

Grid roles (drums / bass / rhythm) stay on a hard 4.0s cut — no trough snap.
Phrase roles (vocal / lead / harmonic / melody) are split on an RMS gate
at −35 dBFS (numpy hop frames, not librosa.effects.split), then pad/trim
to the target window.

Roles come from an explicit section ``role`` tag, a volume-weight key, or
stem folder / file names.
"""
from __future__ import annotations

import os
import re

import numpy as np
import soundfile as sf

GRID_ROLES = frozenset(
    {"drums", "drum", "bass", "rhythm", "perc", "percussion", "kick", "snare", "hats"}
)
PHRASE_ROLES = frozenset(
    {
        "vocal",
        "vocals",
        "vox",
        "lead",
        "harmonic",
        "harmony",
        "melody",
        "melodic",
        "tone",
    }
)
WEIGHT_KEY_ROLES = {
    "rhythm": "rhythm",
    "drums": "drums",
    "bass": "bass",
    "harmonic": "harmonic",
    "lead": "lead",
    "vocal": "vocal",
    "vocals": "vocal",
    "melody": "melody",
}

DEFAULT_GATE_DBFS = -35.0
DEFAULT_MIN_PHRASE_SEC = 0.35
_HOP_MS = 10.0
_FRAME_MS = 40.0


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def normalize_role(value: str | None) -> str | None:
    if not value:
        return None
    token = _slug(value)
    aliases = {
        "drum": "drums",
        "drums": "drums",
        "perc": "drums",
        "percussion": "drums",
        "kick": "drums",
        "snare": "drums",
        "hats": "drums",
        "vox": "vocal",
        "vocals": "vocal",
        "vocal": "vocal",
        "harmony": "harmonic",
        "melodic": "melody",
        "tone": "melody",
    }
    if token in aliases:
        return aliases[token]
    if token in GRID_ROLES or token in PHRASE_ROLES or token in WEIGHT_KEY_ROLES:
        return token
    return token or None


def is_grid_role(role: str | None) -> bool:
    if role is None:
        return True
    return normalize_role(role) in GRID_ROLES or role in {"rhythm", "drums", "bass"}


def is_phrase_role(role: str | None) -> bool:
    if role is None:
        return False
    resolved = normalize_role(role)
    return resolved in PHRASE_ROLES or resolved in {"lead", "harmonic", "vocal", "melody"}


def role_for_weight_key(key: str) -> str:
    return WEIGHT_KEY_ROLES.get(key.lower().strip(), key.lower().strip() or "rhythm")


def infer_role_from_text(text: str) -> str | None:
    tokens = [t for t in _slug(text).split("_") if t]
    joined = "_".join(tokens)
    for token in tokens + [joined]:
        resolved = normalize_role(token)
        if resolved and (resolved in GRID_ROLES or resolved in PHRASE_ROLES or resolved in WEIGHT_KEY_ROLES.values()):
            return resolved
    return None


def infer_role_from_path(path: str) -> str | None:
    parts = [os.path.splitext(os.path.basename(path))[0]]
    parent = os.path.dirname(path)
    for _ in range(3):
        if not parent:
            break
        name = os.path.basename(parent)
        if name:
            parts.append(name)
        parent = os.path.dirname(parent)
    for part in parts:
        role = infer_role_from_text(part)
        if role:
            return role
    return None


def infer_role_from_section(section: dict) -> str | None:
    tagged = section.get("role") or section.get("stem_role")
    if tagged:
        return normalize_role(str(tagged))
    return infer_role_from_text(str(section.get("name") or ""))


def rms_dbfs(signal: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(np.asarray(signal, dtype=np.float64)))))
    if rms < 1e-12:
        return -120.0
    return float(20.0 * np.log10(rms))


def _to_mono(data: np.ndarray) -> np.ndarray:
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        return arr
    return np.mean(arr, axis=1)


def split_on_silence(
    data: np.ndarray,
    sr: int,
    gate_dbfs: float = DEFAULT_GATE_DBFS,
    min_phrase_sec: float = DEFAULT_MIN_PHRASE_SEC,
) -> list[tuple[int, int]]:
    """Hop-frame RMS gate. Returns ``(start, end)`` sample pairs, no librosa."""
    mono = _to_mono(data)
    n = int(mono.shape[0])
    if n == 0:
        return []
    frame = max(1, int(round(sr * _FRAME_MS / 1000.0)))
    hop = max(1, int(round(sr * _HOP_MS / 1000.0)))
    voiced: list[bool] = []
    for start in range(0, n, hop):
        end = min(n, start + frame)
        voiced.append(rms_dbfs(mono[start:end]) >= float(gate_dbfs))
    if not voiced:
        return []

    regions: list[tuple[int, int]] = []
    run_start: int | None = None
    for i, is_voiced in enumerate(voiced):
        if is_voiced and run_start is None:
            run_start = i
        elif not is_voiced and run_start is not None:
            regions.append((run_start * hop, min(n, i * hop + frame)))
            run_start = None
    if run_start is not None:
        regions.append((run_start * hop, n))

    min_samples = max(1, int(round(float(min_phrase_sec) * sr)))
    kept = [(a, b) for a, b in regions if (b - a) >= min_samples]
    return kept


def fade_samples(sr: int, fade_ms: float = 5.0, target: int | None = None) -> int:
    """Sample count for a micro-fade (default 5 ms), never longer than ``target``."""
    n = max(1, int(round(float(sr) * float(fade_ms) / 1000.0)))
    if target is not None:
        n = min(n, max(1, int(target)))
    return n


def pad_or_trim(
    data: np.ndarray,
    target_samples: int,
    sr: int = 44100,
    fade_ms: float = 5.0,
) -> np.ndarray:
    """Fit ``(N, ch)`` to ``target_samples`` with tail pad or a 5 ms fade-trim."""
    arr = np.asarray(data)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    n, ch = arr.shape
    target = int(target_samples)
    if n == target:
        return arr
    if n < target:
        pad = np.zeros((target - n, ch), dtype=arr.dtype)
        return np.vstack([arr, pad])
    trimmed = arr[:target, :].copy()
    fade_len = fade_samples(int(sr), fade_ms=fade_ms, target=target)
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float64)[:, np.newaxis]
    trimmed[-fade_len:, :] *= fade_out.astype(trimmed.dtype, copy=False)
    return trimmed


def load_grid_slice(path: str, target_samples: int) -> np.ndarray:
    """Rigid 4.0s (or N-sample) window. No trough / ZC snap."""
    data, sr = sf.read(path, always_2d=True)
    return pad_or_trim(data, target_samples, sr=int(sr))


def load_gated_phrase(
    path: str,
    target_samples: int,
    gate_dbfs: float = DEFAULT_GATE_DBFS,
    min_phrase_sec: float = DEFAULT_MIN_PHRASE_SEC,
) -> np.ndarray:
    """Longest above-gate region, pad/trim to ``target_samples``."""
    data, sr = sf.read(path, always_2d=True)
    regions = split_on_silence(data, int(sr), gate_dbfs=gate_dbfs, min_phrase_sec=min_phrase_sec)
    if not regions:
        return pad_or_trim(data, target_samples, sr=int(sr))
    start, end = max(regions, key=lambda pair: pair[1] - pair[0])
    return pad_or_trim(data[start:end], target_samples, sr=int(sr))


def load_slice_for_role(
    path: str,
    target_samples: int,
    role: str | None,
    gate_dbfs: float = DEFAULT_GATE_DBFS,
) -> np.ndarray:
    if is_phrase_role(role):
        return load_gated_phrase(path, target_samples, gate_dbfs=gate_dbfs)
    return load_grid_slice(path, target_samples)


def split_pool_by_layer(paths: list[str]) -> dict[str, list[str]]:
    """Bucket corpus paths into rhythm / harmonic / lead / vocal pools."""
    rhythm: list[str] = []
    harmonic: list[str] = []
    lead: list[str] = []
    vocal: list[str] = []
    unknown: list[str] = []
    for path in paths:
        role = infer_role_from_path(path)
        if role in {"drums", "drum", "bass", "rhythm", "perc", "percussion", "kick", "snare"}:
            rhythm.append(path)
        elif role in {"vocal", "vocals"}:
            vocal.append(path)
        elif role in {"lead", "melody"}:
            lead.append(path)
        elif role in {"harmonic", "harmony"}:
            harmonic.append(path)
        else:
            unknown.append(path)
    return {
        "rhythm": rhythm or unknown or list(paths),
        "harmonic": harmonic or unknown or list(paths),
        "lead": lead or unknown or vocal or list(paths),
        "vocal": vocal or lead or unknown or list(paths),
        "unknown": unknown,
    }
