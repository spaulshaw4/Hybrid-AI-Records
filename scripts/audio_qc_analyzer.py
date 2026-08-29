# D:\MusicDatasets\scripts\audio_qc_analyzer.py
"""
===============================================================================
HYBRID 1.0 - POST-RENDER AUDIO QC & LOUDNESS ANALYSIS ENGINE
===============================================================================
Precision QC on rendered masters:
  - Integrated loudness, ITU-R BS.1770-4 (K-weighting + gated integration)
  - True Peak (dBTP) via polyphase 4x oversampling
  - Crest factor and dynamic range
  - Stereo phase correlation (-1.0 to +1.0)
  - DC offset and clipping checks
  - Writes <master>_qc_report.json beside the WAV

On BS.1770 compliance
---------------------
Integrated loudness here implements the actual specification: the two-stage
K-weighting pre-filter (1681.97 Hz high shelf, then 38.14 Hz RLB high pass),
400 ms blocks at 75% overlap, and both gates (absolute -70 LUFS, then relative
-10 LU). Omitting the filter and the gating - computing -0.691 + 10log10 of the
whole-file mean square - reads several dB off a real meter, which matters because
the streaming compliance verdict below is decided on this number.

Filter coefficients are derived from the spec's analog prototype at the file's
own sample rate rather than hardcoded for 48 kHz, so 44.1 kHz masters measure
correctly.
"""

import os
import sys
import wave
import json
import argparse
import numpy as np

try:
    from scipy.signal import lfilter, resample_poly
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False

# BS.1770-4 Annex 1 K-weighting prototype parameters
SHELF_F0 = 1681.974450955533
SHELF_GAIN_DB = 3.999843853973347
SHELF_Q = 0.7071752369554196

HPF_F0 = 38.13547087602444
HPF_Q = 0.5003270373238773

BLOCK_SEC = 0.400
OVERLAP = 0.75
ABSOLUTE_GATE_LUFS = -70.0
RELATIVE_GATE_LU = -10.0


def design_high_shelf(fs: float):
    """
    BS.1770 stage 1 high shelf.

    Uses the bilinear-transform form from the specification, not the RBJ
    high-shelf cookbook formula. They are different filters: the RBJ version
    misses the published 48 kHz coefficients by ~5e-2 and skews the measurement
    by roughly half a dB. The Vb exponent below is the spec's own constant.
    """
    K = np.tan(np.pi * SHELF_F0 / fs)
    Vh = 10.0 ** (SHELF_GAIN_DB / 20.0)
    Vb = Vh ** 0.499666774155

    denom = 1.0 + K / SHELF_Q + K * K

    b = np.array([
        (Vh + Vb * K / SHELF_Q + K * K) / denom,
        2.0 * (K * K - Vh) / denom,
        (Vh - Vb * K / SHELF_Q + K * K) / denom,
    ])
    a = np.array([
        1.0,
        2.0 * (K * K - 1.0) / denom,
        (1.0 - K / SHELF_Q + K * K) / denom,
    ])
    return b, a


def design_high_pass(fs: float):
    """BS.1770 stage 2 RLB high pass, same bilinear-transform form."""
    K = np.tan(np.pi * HPF_F0 / fs)
    denom = 1.0 + K / HPF_Q + K * K

    b = np.array([1.0, -2.0, 1.0])
    a = np.array([
        1.0,
        2.0 * (K * K - 1.0) / denom,
        (1.0 - K / HPF_Q + K * K) / denom,
    ])
    return b, a


def apply_k_weighting(signal: np.ndarray, fs: float) -> np.ndarray:
    b1, a1 = design_high_shelf(fs)
    b2, a2 = design_high_pass(fs)

    out = np.empty_like(signal)
    for ch in range(signal.shape[1]):
        stage1 = lfilter(b1, a1, signal[:, ch])
        out[:, ch] = lfilter(b2, a2, stage1)
    return out


def compute_integrated_lufs(signal: np.ndarray, fs: int):
    """
    Returns (integrated_lufs, loudness_range_lu, method).

    Falls back to an unweighted energy estimate when scipy is absent, and labels
    it as such rather than reporting it as a BS.1770 measurement.
    """
    if signal.size == 0:
        return -99.0, 0.0, "empty"

    if not SCIPY_AVAILABLE:
        ms = float(np.mean(np.sum(signal ** 2, axis=1)))
        if ms <= 1e-12:
            return -99.0, 0.0, "unweighted (scipy unavailable)"
        return round(-0.691 + 10.0 * np.log10(ms), 2), 0.0, "unweighted (scipy unavailable)"

    weighted = apply_k_weighting(signal, fs)

    block_len = int(round(BLOCK_SEC * fs))
    step = max(1, int(round(block_len * (1.0 - OVERLAP))))

    if len(weighted) < block_len:
        # Too short for a single gating block; report ungated over what exists
        ms = float(np.mean(np.sum(weighted ** 2, axis=1)))
        if ms <= 1e-12:
            return -99.0, 0.0, "BS.1770-4 (ungated, clip shorter than 400ms)"
        return round(-0.691 + 10.0 * np.log10(ms), 2), 0.0, "BS.1770-4 (ungated, clip shorter than 400ms)"

    # Per-block mean square summed across channels (G = 1.0 for L and R)
    starts = range(0, len(weighted) - block_len + 1, step)
    block_energy = np.array([
        np.sum(np.mean(weighted[s:s + block_len] ** 2, axis=0)) for s in starts
    ])

    with np.errstate(divide="ignore"):
        block_lufs = -0.691 + 10.0 * np.log10(block_energy + 1e-15)

    # Absolute gate
    above_absolute = block_energy[block_lufs > ABSOLUTE_GATE_LUFS]
    if above_absolute.size == 0:
        return -99.0, 0.0, "BS.1770-4 (all blocks below absolute gate)"

    # Relative gate, derived from the blocks that survived the absolute gate
    relative_reference = -0.691 + 10.0 * np.log10(np.mean(above_absolute) + 1e-15)
    relative_threshold = relative_reference + RELATIVE_GATE_LU

    surviving_mask = (block_lufs > ABSOLUTE_GATE_LUFS) & (block_lufs > relative_threshold)
    surviving = block_energy[surviving_mask]

    if surviving.size == 0:
        surviving = above_absolute

    integrated = -0.691 + 10.0 * np.log10(np.mean(surviving) + 1e-15)

    # Loudness range approximated as the 10th-95th percentile spread of the
    # gated blocks. Full EBU R128 LRA uses a separate short-term windowing;
    # this is a useful proxy, not the certified figure.
    gated_lufs = block_lufs[surviving_mask] if surviving_mask.any() else block_lufs
    lra = float(np.percentile(gated_lufs, 95) - np.percentile(gated_lufs, 10)) if gated_lufs.size > 1 else 0.0

    return round(float(integrated), 2), round(lra, 2), "BS.1770-4 (K-weighted, gated)"


def compute_true_peak_dbtp(signal: np.ndarray, fs: int) -> tuple:
    """
    4x oversampled true peak.

    Uses polyphase resampling rather than linear interpolation: np.interp draws
    straight lines between samples, so it cannot exceed the sample peak and
    systematically under-reports the inter-sample peaks this check exists to find.
    """
    if signal.size == 0:
        return -99.0, "empty"

    if not SCIPY_AVAILABLE:
        peak = float(np.max(np.abs(signal)))
        return round(float(20.0 * np.log10(peak + 1e-9)), 2), "sample peak (scipy unavailable)"

    max_peak = 0.0
    for ch in range(signal.shape[1]):
        oversampled = resample_poly(signal[:, ch], up=4, down=1)
        max_peak = max(max_peak, float(np.max(np.abs(oversampled))))

    # float() before round(): np.log10 returns np.float64 even for a Python
    # float input, and a np.float64 comparison later yields np.bool_, which
    # json.dump rejects when the report is written.
    return round(float(20.0 * np.log10(max_peak + 1e-9)), 2), "4x polyphase oversampled"


def compute_phase_correlation(stereo_signal: np.ndarray) -> float:
    left = stereo_signal[:, 0]
    right = stereo_signal[:, 1]

    denom = np.sqrt(np.sum(left ** 2) * np.sum(right ** 2)) + 1e-12
    return float(np.clip(np.sum(left * right) / denom, -1.0, 1.0))


def read_wav(wav_path: str):
    with wave.open(wav_path, "rb") as wav:
        n_ch = wav.getnchannels()
        sw = wav.getsampwidth()
        fr = wav.getframerate()
        nf = wav.getnframes()
        raw = wav.readframes(nf)

    if sw == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 3:
        usable = (len(raw) // 3) * 3
        padded = bytearray()
        for i in range(0, usable, 3):
            padded.extend(b"\x00" + raw[i:i + 3])
        data = np.frombuffer(bytes(padded), dtype="<i4").astype(np.float32) / 2147483648.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    else:
        raise ValueError(f"Unsupported sample width: {sw}")

    if n_ch == 1:
        data = np.column_stack((data, data))
    else:
        usable = (len(data) // n_ch) * n_ch
        data = data[:usable].reshape(-1, n_ch)
        if n_ch > 2:
            data = data[:, :2]

    return data.astype(np.float64), fr, sw, n_ch, nf


def analyze_master_qc(wav_path: str, target_lufs_min=-16.0, target_lufs_max=-9.0,
                      true_peak_ceiling=-0.1, report_out=None) -> dict:
    if not os.path.exists(wav_path):
        raise FileNotFoundError(f"Master file not found: {wav_path}")

    data, fr, sw, n_ch, nf = read_wav(wav_path)

    if data.size == 0:
        raise ValueError(f"No decodable audio in {wav_path}")

    peak_sample_linear = float(np.max(np.abs(data)))
    sample_peak_dbfs = float(20.0 * np.log10(peak_sample_linear + 1e-9))

    rms_linear = float(np.sqrt(np.mean(data ** 2)))
    rms_dbfs = float(20.0 * np.log10(rms_linear + 1e-9))
    crest_factor_db = float(sample_peak_dbfs - rms_dbfs)

    true_peak_dbtp, tp_method = compute_true_peak_dbtp(data, fr)
    integrated_lufs, lra_lu, lufs_method = compute_integrated_lufs(data, fr)
    phase_correlation = compute_phase_correlation(data)

    dc_offset_l = float(np.mean(data[:, 0]))
    dc_offset_r = float(np.mean(data[:, 1]))

    duration_sec = round(nf / fr, 2)
    file_size_mb = round(os.path.getsize(wav_path) / (1024.0 * 1024.0), 2)

    streaming_lufs_pass = bool(target_lufs_min <= integrated_lufs <= target_lufs_max)
    true_peak_pass = bool(true_peak_dbtp <= true_peak_ceiling)
    phase_pass = bool(phase_correlation > 0.15)
    dc_pass = bool(abs(dc_offset_l) < 0.001 and abs(dc_offset_r) < 0.001)

    report = {
        "master_file": os.path.basename(wav_path),
        "sample_rate": fr,
        "bit_depth": sw * 8,
        "channels": n_ch,
        "duration_sec": duration_sec,
        "size_mb": file_size_mb,
        "metrics": {
            "integrated_lufs": float(integrated_lufs),
            "loudness_range_lu": float(lra_lu),
            "lufs_method": lufs_method,
            "sample_peak_dbfs": round(float(sample_peak_dbfs), 2),
            "true_peak_dbtp": float(true_peak_dbtp),
            "true_peak_method": tp_method,
            "rms_loudness_dbfs": round(float(rms_dbfs), 2),
            "crest_factor_db": round(float(crest_factor_db), 2),
            "stereo_phase_correlation": round(float(phase_correlation), 3),
            "dc_offset": {"left": round(float(dc_offset_l), 6), "right": round(float(dc_offset_r), 6)}
        },
        "targets": {
            "lufs_window": [target_lufs_min, target_lufs_max],
            "true_peak_ceiling_dbtp": true_peak_ceiling
        },
        "compliance": {
            "streaming_target_met": streaming_lufs_pass,
            "true_peak_safety_met": true_peak_pass,
            "phase_compatibility_met": phase_pass,
            "dc_offset_clean": dc_pass,
            # Loudness is deliberately excluded from the overall verdict: a
            # quiet master is a mix decision, whereas a true-peak overshoot or a
            # phase-cancelling mix is a defect.
            "overall_qc_passed": bool(true_peak_pass and phase_pass and dc_pass)
        }
    }

    if report_out is None:
        report_out = os.path.splitext(wav_path)[0] + "_qc_report.json"

    with open(report_out, "w", encoding="utf-8") as out_f:
        json.dump(report, out_f, indent=2)

    m = report["metrics"]
    c = report["compliance"]

    print("================================================================")
    print("HYBRID 1.0 - AUDIO MASTER QUALITY CONTROL REPORT")
    print("================================================================")
    print(f"Master File : {report['master_file']} ({report['bit_depth']}-bit / {fr} Hz / {duration_sec}s)")
    print(f"Loudness    : {m['integrated_lufs']} LUFS  (LRA {m['loudness_range_lu']} LU)")
    print(f"              method: {m['lufs_method']}")
    print(f"True Peak   : {m['true_peak_dbtp']} dBTP  (sample peak {m['sample_peak_dbfs']} dBFS)")
    print(f"              method: {m['true_peak_method']}")
    print(f"Dynamics    : {m['crest_factor_db']} dB crest factor")
    print(f"Phase Coeff : {m['stereo_phase_correlation']}")
    print(f"DC Offset   : L {m['dc_offset']['left']}  R {m['dc_offset']['right']}")
    print("----------------------------------------------------------------")
    print(f"  true peak <= {true_peak_ceiling} dBTP    : {'PASS' if c['true_peak_safety_met'] else 'FAIL'}")
    print(f"  phase correlation > 0.15   : {'PASS' if c['phase_compatibility_met'] else 'FAIL'}")
    print(f"  DC offset clean            : {'PASS' if c['dc_offset_clean'] else 'FAIL'}")
    print(f"  loudness in [{target_lufs_min}, {target_lufs_max}] : "
          f"{'PASS' if c['streaming_target_met'] else 'outside window (informational)'}")
    print("----------------------------------------------------------------")
    print(f"QC VERDICT  : {'[PASS]' if c['overall_qc_passed'] else '[FAIL]'}")
    print(f"Report      : {report_out}")
    print("================================================================")

    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 audio QC analyzer")
    parser.add_argument("--wav-path", required=True, help="Path to master WAV file")
    parser.add_argument("--report-out", default=None, help="Override report JSON path")
    parser.add_argument("--lufs-min", type=float, default=-16.0)
    parser.add_argument("--lufs-max", type=float, default=-9.0)
    parser.add_argument("--true-peak-ceiling", type=float, default=-0.1)
    parser.add_argument("--fail-on-loudness", action="store_true",
                        help="Also gate the exit code on the loudness window")
    args = parser.parse_args()

    rep = analyze_master_qc(
        args.wav_path,
        target_lufs_min=args.lufs_min,
        target_lufs_max=args.lufs_max,
        true_peak_ceiling=args.true_peak_ceiling,
        report_out=args.report_out
    )

    ok = rep["compliance"]["overall_qc_passed"]
    if args.fail_on_loudness:
        ok = ok and rep["compliance"]["streaming_target_met"]

    sys.exit(0 if ok else 1)
