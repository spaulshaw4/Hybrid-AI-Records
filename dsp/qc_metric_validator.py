"""Spectral / delivery QC. True peak is 4× oversampled dBTP, never sample peak.

Gates (fail = exit 1):
  true_peak_dbtp  <= -0.50
  phase           >=  0.80   (Pearson / normalized L-R correlation; mono = 1.0)
  sub_energy_frac <=  0.45   (20–60 Hz share of band energy)

Warn-only: phase < 0.40 is flagged as mono-risk in addition to the fail at 0.80.
Sample peak and crest are reported separately and are not labeled dBTP.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

import numpy as np
from scipy.signal import stft

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.abspath(os.path.join(_HERE, ".."))
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from dsp.true_peak_limiter import measure_true_peak_dbtp  # noqa: E402

try:
    from scripts.qc_master_gate import measure as _gate_measure
except Exception:  # noqa: BLE001
    _gate_measure = None

TRUE_PEAK_CEILING_DBTP = -0.50
PHASE_FAIL = 0.80
PHASE_MONO_WARN = 0.40
SUB_ENERGY_FAIL = 0.45
BANDS_HZ = (
    ("sub", 20.0, 60.0),
    ("bass", 60.0, 250.0),
    ("low_mids", 250.0, 1000.0),
    ("high_mids", 1000.0, 4000.0),
    ("highs", 4000.0, 12000.0),
    ("air", 12000.0, 20000.0),
)


def _as_frames(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis]
    return data


def phase_correlation(audio: np.ndarray) -> float:
    frames = _as_frames(audio)
    if frames.shape[0] == 0:
        return 1.0
    if frames.shape[1] < 2:
        return 1.0
    left = frames[:, 0] - np.mean(frames[:, 0])
    right = frames[:, 1] - np.mean(frames[:, 1])
    denom = (np.sqrt(np.sum(left * left)) * np.sqrt(np.sum(right * right))) + 1e-12
    return float(np.sum(left * right) / denom)


def sample_peak_dbfs(audio: np.ndarray) -> float:
    peak = float(np.max(np.abs(_as_frames(audio))))
    return float(20.0 * np.log10(peak + 1e-12))


def rms_dbfs(audio: np.ndarray) -> float:
    frames = _as_frames(audio)
    if frames.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(frames * frames)))
    return float(20.0 * np.log10(rms + 1e-12))


def band_energies(audio: np.ndarray, sr: int) -> dict[str, float]:
    frames = _as_frames(audio)
    if frames.size == 0 or sr <= 0:
        return {name: 0.0 for name, _, _ in BANDS_HZ}
    mono = np.mean(frames, axis=1)
    nperseg = min(4096, max(256, int(len(mono))))
    _f, _t, zxx = stft(mono, fs=float(sr), nperseg=nperseg, noverlap=nperseg // 2)
    power = np.mean(np.abs(zxx) ** 2, axis=1)
    freqs = np.asarray(_f, dtype=np.float64)
    nyquist = float(sr) / 2.0
    totals: dict[str, float] = {}
    for name, lo, hi in BANDS_HZ:
        hi_clamped = min(hi, nyquist)
        if hi_clamped <= lo:
            totals[name] = 0.0
            continue
        mask = (freqs >= lo) & (freqs < hi_clamped)
        totals[name] = float(np.sum(power[mask])) if np.any(mask) else 0.0
    return totals


def measure_qc(audio: np.ndarray, sr: int) -> dict[str, Any]:
    frames = _as_frames(audio)
    true_peak = float(measure_true_peak_dbtp(frames))
    sample_peak = sample_peak_dbfs(frames)
    rms = rms_dbfs(frames)
    crest = float(sample_peak - rms)
    phase = phase_correlation(frames)
    bands = band_energies(frames, int(sr))
    energy_sum = sum(bands.values()) + 1e-12
    fractions = {f"{name}_frac": bands[name] / energy_sum for name in bands}
    sub_frac = float(fractions["sub_frac"])

    failures: list[str] = []
    warnings: list[str] = []
    if true_peak > TRUE_PEAK_CEILING_DBTP:
        failures.append(f"true_peak_dbtp {true_peak:.3f} > {TRUE_PEAK_CEILING_DBTP:.2f}")
    if phase < PHASE_FAIL:
        failures.append(f"phase {phase:.3f} < {PHASE_FAIL:.2f}")
    if phase < PHASE_MONO_WARN:
        warnings.append(f"mono_risk phase {phase:.3f} < {PHASE_MONO_WARN:.2f} (warn; fail already at {PHASE_FAIL:.2f})")
    if sub_frac > SUB_ENERGY_FAIL:
        failures.append(f"sub_energy_frac {sub_frac:.3f} > {SUB_ENERGY_FAIL:.2f}")

    report: dict[str, Any] = {
        "pass": len(failures) == 0,
        "true_peak_dbtp": round(true_peak, 3),
        "true_peak_method": "4x_oversample_isp",
        "sample_peak_dbfs": round(sample_peak, 3),
        "rms_dbfs": round(rms, 3),
        "crest_db": round(crest, 3),
        "phase_correlation": round(phase, 3),
        "band_energy": {k: round(v, 8) for k, v in bands.items()},
        "band_energy_frac": {k: round(v, 4) for k, v in fractions.items()},
        "gates": {
            "true_peak_dbtp_max": TRUE_PEAK_CEILING_DBTP,
            "phase_min": PHASE_FAIL,
            "phase_mono_warn": PHASE_MONO_WARN,
            "sub_energy_frac_max": SUB_ENERGY_FAIL,
        },
        "failures": failures,
        "warnings": warnings,
        "sample_rate": int(sr),
        "channels": int(frames.shape[1]),
        "duration_sec": round(frames.shape[0] / float(sr), 3) if sr else 0.0,
    }
    if _gate_measure is not None:
        report["qc_master_gate_available"] = True
    return report


def validate_file(path: str) -> dict[str, Any]:
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    import soundfile as sf

    audio, sr = sf.read(path, always_2d=True)
    report = measure_qc(audio, int(sr))
    report["input"] = os.path.abspath(path)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Spectral / true-peak QC (dBTP is 4x OS, not sample peak)")
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args()
    try:
        report = validate_file(args.input)
    except FileNotFoundError as exc:
        print(json.dumps({"error": "missing_input", "path": str(exc)}), file=sys.stderr)
        return 1
    text = json.dumps(report, indent=2)
    print(text)
    if args.json_out:
        parent = os.path.dirname(os.path.abspath(args.json_out))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.write("\n")
    return 0 if report.get("pass") else 1


if __name__ == "__main__":
    sys.exit(main())
