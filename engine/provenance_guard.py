"""Module 5 — Provenance safeguard (fingerprint collision + uniqueness drift)."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np

from engine.dsp_utils import to_mono
from engine.song_evaluator import compute_chromagram

SIMILARITY_THRESHOLD = 0.75
DRIFT_MIN = 0.01
DRIFT_MAX = 0.02
BARS_PER_SEGMENT = 4


@dataclass
class ProvenanceReport:
    certified: bool
    max_similarity: float
    threshold: float
    flagged_segments: list[dict[str, Any]] = field(default_factory=list)
    certification_hash: str = ""
    transforms_applied: list[dict[str, Any]] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "certified": self.certified,
            "max_similarity": self.max_similarity,
            "threshold": self.threshold,
            "flagged_segments": list(self.flagged_segments),
            "certification_hash": self.certification_hash,
            "transforms_applied": list(self.transforms_applied),
            "details": dict(self.details),
        }


def segment_sample_count(sr: int, bpm: float, bars: int = BARS_PER_SEGMENT) -> int:
    return max(1, int(round(float(sr) * 60.0 * 4.0 * float(bars) / max(1.0, float(bpm)))))


def fingerprint_vector(audio: np.ndarray, sr: int) -> np.ndarray:
    """Compact chromagram + spectral-band fingerprint (L2-normalized)."""
    mono = to_mono(audio)
    chroma = compute_chromagram(mono, int(sr))
    # Log-magnitude spectrum bands for collision sensitivity.
    n_fft = min(2048, max(256, mono.size))
    window = np.hanning(n_fft)
    if mono.size < n_fft:
        frame = np.pad(mono, (0, n_fft - mono.size))
    else:
        frame = mono[:n_fft]
    spec = np.abs(np.fft.rfft(frame * window))
    bands = np.array_split(spec, 8)
    band_e = np.array([float(np.mean(b) + 1e-12) for b in bands], dtype=np.float64)
    band_e = np.log1p(band_e)
    vec = np.concatenate([chroma, band_e])
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 1e-12 else vec


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    aa = np.asarray(a, dtype=np.float64).ravel()
    bb = np.asarray(b, dtype=np.float64).ravel()
    n = min(aa.size, bb.size)
    if n == 0:
        return 0.0
    aa = aa[:n]
    bb = bb[:n]
    denom = float(np.linalg.norm(aa) * np.linalg.norm(bb))
    if denom < 1e-18:
        return 0.0
    return float(np.clip(np.dot(aa, bb) / denom, -1.0, 1.0))


def apply_uniqueness_drift(
    audio: np.ndarray,
    sr: int,
    *,
    drift: float = 0.015,
    seed: int = 0,
) -> np.ndarray:
    """1–2 % micro pitch/timing offset to break corpus clones.

    ``seed`` fully determines the timing/pitch direction. Every channel gets
    the same transform, and callers must pass one seed to the master and all
    stems of a session so they stay sample-aligned.
    """
    drift = float(np.clip(drift, DRIFT_MIN, DRIFT_MAX))
    rng = np.random.default_rng(int(seed))
    # Alternate timing stretch vs tiny pitch lean so clones diverge.
    timing = 1.0 + drift * (1.0 if rng.random() < 0.5 else -1.0)
    pitch_st = drift * 12.0 * (1.0 if rng.random() < 0.5 else -1.0)  # ~0.12–0.24 st
    data = np.asarray(audio, dtype=np.float64)
    # Timing: linear resample ratio.
    if data.ndim == 1:
        new_n = max(1, int(round(data.shape[0] / timing)))
        x_old = np.linspace(0.0, 1.0, data.shape[0])
        x_new = np.linspace(0.0, 1.0, new_n)
        stretched = np.interp(x_new, x_old, data)
        # Pad/trim back to original length.
        if stretched.size < data.size:
            stretched = np.pad(stretched, (0, data.size - stretched.size))
        else:
            stretched = stretched[: data.size]
        # Micro pitch via resample ratio (also nudges formants slightly — intentional).
        ratio = 2.0 ** (pitch_st / 12.0)
        mid_n = max(1, int(round(stretched.size / ratio)))
        pitched = np.interp(
            np.linspace(0.0, 1.0, mid_n),
            np.linspace(0.0, 1.0, stretched.size),
            stretched,
        )
        if pitched.size < data.size:
            pitched = np.pad(pitched, (0, data.size - pitched.size))
        return pitched[: data.size]
    channels = []
    for ch in range(data.shape[1]):
        channels.append(
            apply_uniqueness_drift(data[:, ch], sr, drift=drift, seed=seed)
        )
    return np.column_stack(channels)


class ProvenanceGuard:
    """Fingerprint the master/stems and collide against a local SQLite corpus cache."""

    def __init__(
        self,
        *,
        conn: sqlite3.Connection | None = None,
        index_db: str | None = None,
        threshold: float = SIMILARITY_THRESHOLD,
        bpm: float = 120.0,
        sr: int = 44100,
    ) -> None:
        self.threshold = float(threshold)
        self.bpm = float(bpm)
        self.sr = int(sr)
        self._owned = False
        self.conn = conn
        if self.conn is None and index_db and os.path.isfile(index_db):
            try:
                self.conn = sqlite3.connect(index_db)
                self._owned = True
            except sqlite3.Error:
                self.conn = None
        self._ensure_fingerprint_table()
        self._memory_refs: list[dict[str, Any]] = []

    def close(self) -> None:
        if self._owned and self.conn is not None:
            self.conn.close()
            self.conn = None

    def _ensure_fingerprint_table(self) -> None:
        if self.conn is None:
            return
        try:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS stem_fingerprints (
                    id INTEGER PRIMARY KEY,
                    file_path TEXT UNIQUE,
                    fingerprint TEXT NOT NULL,
                    source TEXT DEFAULT 'corpus'
                )
                """
            )
            self.conn.commit()
        except sqlite3.Error:
            pass

    def register_reference(
        self,
        audio: np.ndarray,
        *,
        file_path: str = "",
        source: str = "corpus",
    ) -> np.ndarray:
        """Index a proprietary stem fingerprint (memory + optional SQLite)."""
        vec = fingerprint_vector(audio, self.sr)
        payload = {
            "file_path": file_path or f"mem:{len(self._memory_refs)}",
            "fingerprint": vec,
            "source": source,
        }
        self._memory_refs.append(payload)
        if self.conn is not None and file_path:
            try:
                self.conn.execute(
                    "INSERT OR REPLACE INTO stem_fingerprints(file_path, fingerprint, source) "
                    "VALUES (?,?,?)",
                    (file_path, json.dumps(vec.tolist()), source),
                )
                self.conn.commit()
            except sqlite3.Error:
                pass
        return vec

    def _iter_corpus_vectors(self) -> list[tuple[str, np.ndarray]]:
        out: list[tuple[str, np.ndarray]] = []
        for item in self._memory_refs:
            out.append((str(item["file_path"]), np.asarray(item["fingerprint"], dtype=np.float64)))
        if self.conn is None:
            return out
        try:
            rows = self.conn.execute(
                "SELECT file_path, fingerprint FROM stem_fingerprints"
            ).fetchall()
        except sqlite3.Error:
            return out
        for path, blob in rows:
            try:
                vec = np.asarray(json.loads(blob), dtype=np.float64)
            except (TypeError, json.JSONDecodeError):
                continue
            out.append((str(path), vec))
        return out

    def check(
        self,
        master: np.ndarray,
        *,
        stems: Mapping[str, np.ndarray] | None = None,
        seed: int = 0,
        auto_remediate: bool = True,
    ) -> tuple[np.ndarray, dict[str, np.ndarray], ProvenanceReport]:
        """Score 4-bar segments; remediate clones with micro drift when flagged."""
        seg_n = segment_sample_count(self.sr, self.bpm, BARS_PER_SEGMENT)
        master_out = np.asarray(master, dtype=np.float64)
        stems_out: dict[str, np.ndarray] = {
            k: np.asarray(v, dtype=np.float64) for k, v in (stems or {}).items()
        }
        refs = self._iter_corpus_vectors()
        flagged: list[dict[str, Any]] = []
        transforms: list[dict[str, Any]] = []
        max_sim = 0.0

        def scan(name: str, audio: np.ndarray) -> list[tuple[int, float, str]]:
            hits: list[tuple[int, float, str]] = []
            n = audio.shape[0]
            if n < 16 or not refs:
                return hits
            # Use 4-bar windows when long enough; otherwise fingerprint the whole buffer.
            win = seg_n if n >= max(256, seg_n // 2) else n
            idx = 0
            seg_i = 0
            while idx < n:
                chunk = audio[idx : idx + win]
                if chunk.size < 64:
                    break
                vec = fingerprint_vector(chunk, self.sr)
                best = 0.0
                best_path = ""
                for path, ref in refs:
                    sim = cosine_similarity(vec, ref)
                    if sim > best:
                        best = sim
                        best_path = path
                hits.append((seg_i, best, best_path))
                if win >= n:
                    break
                idx += win
                seg_i += 1
            return hits

        # Prefer master scan; also scan stems for stem-level clones.
        targets: list[tuple[str, np.ndarray]] = [("master", master_out)]
        for name, audio in stems_out.items():
            targets.append((name, audio))

        for name, audio in targets:
            for seg_i, sim, path in scan(name, audio):
                max_sim = max(max_sim, sim)
                if sim > self.threshold:
                    flagged.append(
                        {
                            "stream": name,
                            "segment_index": seg_i,
                            "similarity": round(sim, 4),
                            "matched_path": path,
                        }
                    )

        if flagged and auto_remediate:
            drift = float(np.clip(0.01 + 0.01 * (max_sim - self.threshold), DRIFT_MIN, DRIFT_MAX))
            master_out = apply_uniqueness_drift(master_out, self.sr, drift=drift, seed=seed)
            for key in list(stems_out.keys()):
                stems_out[key] = apply_uniqueness_drift(
                    stems_out[key], self.sr, drift=drift, seed=seed
                )
            transforms.append({"type": "micro_pitch_timing_drift", "drift": drift})
            # Re-scan master after remediation.
            max_sim = 0.0
            flagged_after: list[dict[str, Any]] = []
            for seg_i, sim, path in scan("master", master_out):
                max_sim = max(max_sim, sim)
                if sim > self.threshold:
                    flagged_after.append(
                        {
                            "stream": "master",
                            "segment_index": seg_i,
                            "similarity": round(sim, 4),
                            "matched_path": path,
                        }
                    )
            flagged = flagged_after

        # No reference fingerprints means nothing was compared: never certify.
        status = "checked" if refs else "unverified_no_references"
        certified = bool(refs) and max_sim <= self.threshold and not flagged
        digest = hashlib.sha256(
            json.dumps(
                {
                    "max_similarity": round(max_sim, 6),
                    "threshold": self.threshold,
                    "flagged": flagged,
                    "transforms": transforms,
                    "seed": seed,
                    "status": status,
                    "references": len(refs),
                },
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        report = ProvenanceReport(
            certified=bool(certified),
            max_similarity=round(float(max_sim), 4),
            threshold=self.threshold,
            flagged_segments=flagged,
            certification_hash=digest,
            transforms_applied=transforms,
            details={
                "segments_scanned": bool(refs),
                "references": len(refs),
                "status": status,
            },
        )
        return master_out, stems_out, report
