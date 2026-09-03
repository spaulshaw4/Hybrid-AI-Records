"""Polarity / invert-sum check between a candidate and a reference."""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass

import numpy as np

# Flip when the inverted sum is both more in-phase toward +1 and louder:
#   corr(-A, B) is closer to +1 than corr(A, B)
#   AND rms(-A + B) > rms(A + B)
# Silent inputs yield NaN correlation and never recommend a flip.


@dataclass(frozen=True)
class PolarityReport:
    correlation: float
    inverted_correlation: float
    sum_rms: float
    inverted_sum_rms: float
    recommend_flip: bool
    silent: bool


def _as_mono(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data
    if data.ndim == 2:
        return np.mean(data, axis=1)
    raise ValueError("audio must be shape (N,) or (N, ch)")


def _load_audio(path: str) -> np.ndarray:
    import soundfile as sf

    data, _sr = sf.read(path, always_2d=False)
    return np.asarray(data, dtype=np.float64)


def _correlation(a: np.ndarray, b: np.ndarray) -> float:
    if a.size == 0 or b.size == 0:
        return float("nan")
    if float(np.max(np.abs(a))) < 1e-12 or float(np.max(np.abs(b))) < 1e-12:
        return float("nan")
    a0 = a - np.mean(a)
    b0 = b - np.mean(b)
    denom = float(np.sqrt(np.sum(a0 * a0)) * np.sqrt(np.sum(b0 * b0)))
    if denom < 1e-12:
        return float("nan")
    return float(np.sum(a0 * b0) / denom)


def _rms(audio: np.ndarray) -> float:
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio * audio)))


def check_polarity(candidate: np.ndarray | str, reference: np.ndarray | str) -> PolarityReport:
    """Compare candidate vs reference. Accepts ndarrays or filesystem paths."""
    left = _load_audio(candidate) if isinstance(candidate, str) else np.asarray(candidate)
    right = _load_audio(reference) if isinstance(reference, str) else np.asarray(reference)
    a = _as_mono(left)
    b = _as_mono(right)
    n = min(a.shape[0], b.shape[0])
    a = a[:n]
    b = b[:n]
    corr = _correlation(a, b)
    inv_corr = _correlation(-a, b)
    sum_rms = _rms(a + b)
    inv_sum_rms = _rms(-a + b)
    silent = bool(not np.isfinite(corr) or not np.isfinite(inv_corr))
    # Toward +1: the inverted pairing is more positively correlated, not merely larger |r|.
    closer_to_plus_one = (not silent) and (inv_corr > corr)
    recommend = (not silent) and closer_to_plus_one and (inv_sum_rms > sum_rms)
    return PolarityReport(
        correlation=corr,
        inverted_correlation=inv_corr,
        sum_rms=sum_rms,
        inverted_sum_rms=inv_sum_rms,
        recommend_flip=recommend,
        silent=silent,
    )


def recommend_invert(candidate: np.ndarray | str, reference: np.ndarray | str) -> bool:
    return check_polarity(candidate, reference).recommend_flip


def main() -> int:
    parser = argparse.ArgumentParser(description="Recommend polarity flip if inverted sum is louder and more +1 correlated.")
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--reference", required=True)
    args = parser.parse_args()
    report = check_polarity(args.candidate, args.reference)
    print(json.dumps(asdict(report), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
