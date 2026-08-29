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

# Acceptance standards and enforcement thresholds, per architecture spec
# section 5. Defined here rather than lower down because they are used as
# default argument values, which Python evaluates at function definition time.
#
# The phase band has an upper bound as well as a lower one: below +0.25 the mix
# cancels on a mono speaker, above +0.95 it is effectively mono already and the
# Q2 width stage has accomplished nothing. SPEC_PHASE_WARN is the separate,
# lower threshold the spec sets for the mono-incompatibility warning.
SPEC_LUFS_TARGET = -14.0
SPEC_LUFS_TOLERANCE = 1.0
SPEC_TRUE_PEAK_CEILING = -0.5
SPEC_PHASE_MIN = 0.25
SPEC_PHASE_MAX = 0.95
SPEC_PHASE_WARN = 0.15
SPEC_DC_LIMIT = 0.0001
SPEC_REGAIN_DEVIATION_LU = 1.5

# Genre-calibrated compliance. A single threshold set is wrong in both
# directions: the default 0.25 phase floor fails a correctly made ambient
# master, where 0.15 width is intentional, while passing a rap master that is
# too wide for a genre wanting 0.65 or above. Loudness targets differ by 5 LU
# across these profiles, and true-peak ceilings by 0.7 dB.
#
# Values follow the Cortex compliance matrix. "default" is the section 7
# baseline, used when no genre is supplied.
GENRE_COMPLIANCE = {
    "default": {
        "lufs_min": -15.0, "lufs_max": -13.0,
        "true_peak_ceiling": -0.50,
        "phase_min": 0.25, "phase_max": 0.95,
        "crest_min": None, "crest_max": None,
        "dc_limit": 0.0001,
    },
    "rap": {
        "lufs_min": -11.0, "lufs_max": -9.0,
        "true_peak_ceiling": -0.30,
        "phase_min": 0.65, "phase_max": 1.00,
        "crest_min": 6.0, "crest_max": 8.0,
        "dc_limit": 0.0001,
    },
    "distorted_rock": {
        "lufs_min": -10.5, "lufs_max": -8.5,
        "true_peak_ceiling": -0.50,
        "phase_min": 0.40, "phase_max": 0.95,
        "crest_min": 5.5, "crest_max": 7.5,
        "dc_limit": 0.0001,
    },
    "space_trippy": {
        "lufs_min": -16.0, "lufs_max": -14.0,
        "true_peak_ceiling": -1.00,
        "phase_min": 0.15, "phase_max": 0.95,
        "crest_min": 10.0, "crest_max": 14.0,
        "dc_limit": 0.0001,
    },
}

# Aliases onto the compliance profiles above
GENRE_ALIASES = {
    "trap": "rap", "modern_rap": "rap", "hiphop": "rap", "hip_hop": "rap",
    "rap_rock": "rap",
    "rock": "distorted_rock", "heavy_alternative_rock": "distorted_rock",
    "nu_metal": "distorted_rock", "metal": "distorted_rock",
    "ambient": "space_trippy", "psychedelic": "space_trippy",
    "space": "space_trippy", "trippy": "space_trippy",
}


def resolve_compliance(genre: str = None):
    """Returns (profile_dict, resolved_name)."""
    if not genre:
        return GENRE_COMPLIANCE["default"], "default"

    key = str(genre).strip().lower().replace("-", "_").replace(" ", "_")

    if key in GENRE_COMPLIANCE:
        return GENRE_COMPLIANCE[key], key

    if key in GENRE_ALIASES:
        target = GENRE_ALIASES[key]
        return GENRE_COMPLIANCE[target], f"{key} -> {target}"

    return GENRE_COMPLIANCE["default"], f"{key} -> default (no profile)"


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


def plan_loudness_regain(current_lufs, current_true_peak_dbtp,
                         target_lufs=SPEC_LUFS_TARGET,
                         deviation_trigger=SPEC_REGAIN_DEVIATION_LU,
                         true_peak_ceiling=SPEC_TRUE_PEAK_CEILING):
    """
    Decide the gain needed to bring loudness to target, per spec section 5's
    "re-gain stage master bus if deviation > 1.5 LUFS".

    Returns (should_apply, gain_db, reason).

    The gain is capped by available true-peak headroom. Loudness and peak move
    together, so applying the full correction to a quiet-but-peaky master would
    push it past -0.5 dBTP and trade a soft failure for a hard one. When the cap
    binds, the master is left short of target rather than made non-compliant.
    """
    if current_lufs <= -99.0:
        return False, 0.0, "loudness unmeasurable (silent or near-silent)"

    deviation = target_lufs - current_lufs

    if abs(deviation) <= deviation_trigger:
        return False, 0.0, f"within {deviation_trigger} LU of target ({deviation:+.2f} LU)"

    headroom_db = true_peak_ceiling - current_true_peak_dbtp

    if deviation > 0:
        # Turning up: bounded by true-peak headroom
        gain_db = min(deviation, headroom_db)
        if gain_db <= 0.01:
            return False, 0.0, (f"needs {deviation:+.2f} dB but only {headroom_db:.2f} dB "
                                f"of true-peak headroom remains")
        capped = gain_db < deviation - 0.01
        reason = (f"raising {gain_db:+.2f} dB toward {target_lufs} LUFS"
                  + (f" (capped from {deviation:+.2f} by true-peak headroom)" if capped else ""))
        return True, gain_db, reason

    # Turning down is always safe for peak
    return True, deviation, f"lowering {deviation:+.2f} dB toward {target_lufs} LUFS"


def compute_phase_correlation(stereo_signal: np.ndarray) -> float:
    left = stereo_signal[:, 0]
    right = stereo_signal[:, 1]

    denom = np.sqrt(np.sum(left ** 2) * np.sum(right ** 2)) + 1e-12
    return float(np.clip(np.sum(left * right) / denom, -1.0, 1.0))


def dbfs_to_linear_scalar(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def apply_ceiling_clamp(signal: np.ndarray, true_peak_ceiling=SPEC_TRUE_PEAK_CEILING) -> np.ndarray:
    """Scale down if the post-gain peak sits above the ceiling."""
    ceiling_linear = dbfs_to_linear_scalar(true_peak_ceiling)
    peak = float(np.max(np.abs(signal)))

    if peak > ceiling_linear and peak > 0:
        signal = signal * (ceiling_linear / peak)
        print(f"[RE-GAIN] Scaled back {20.0 * np.log10(ceiling_linear / peak):+.2f} dB "
              f"to hold the {true_peak_ceiling} dBTP ceiling")

    return np.clip(signal, -ceiling_linear, ceiling_linear)


def write_wav(wav_path: str, signal: np.ndarray, sample_rate: int, sampwidth: int):
    """Write back at the original bit depth. No dither: the signal was already
    quantized once, and re-dithering a re-gained master adds a second noise
    floor for no benefit."""
    import struct

    with wave.open(wav_path, "wb") as out:
        out.setnchannels(signal.shape[1])
        out.setframerate(sample_rate)
        out.setsampwidth(sampwidth)

        if sampwidth == 2:
            out.writeframes(np.clip(signal * 32767.0, -32768.0, 32767.0).astype("<i2").tobytes())
        elif sampwidth == 3:
            quant = np.clip(signal * 8388607.0, -8388608.0, 8388607.0).astype("<i4")
            raw = bytearray()
            for s in quant.flatten():
                raw.extend(struct.pack("<i", int(s))[:3])
            out.writeframes(bytes(raw))
        else:
            out.writeframes(signal.astype("<f4").tobytes())


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


def analyze_master_qc(wav_path: str,
                      target_lufs_min=SPEC_LUFS_TARGET - SPEC_LUFS_TOLERANCE,
                      target_lufs_max=SPEC_LUFS_TARGET + SPEC_LUFS_TOLERANCE,
                      true_peak_ceiling=SPEC_TRUE_PEAK_CEILING,
                      phase_min=SPEC_PHASE_MIN, phase_max=SPEC_PHASE_MAX,
                      dc_limit=SPEC_DC_LIMIT, report_out=None) -> dict:
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
    phase_pass = bool(phase_min <= phase_correlation <= phase_max)
    dc_pass = bool(abs(dc_offset_l) < dc_limit and abs(dc_offset_r) < dc_limit)

    regain_needed, regain_gain_db, regain_reason = plan_loudness_regain(
        integrated_lufs, true_peak_dbtp,
        target_lufs=(target_lufs_min + target_lufs_max) / 2.0,
        true_peak_ceiling=true_peak_ceiling
    )

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
            "true_peak_ceiling_dbtp": true_peak_ceiling,
            "phase_window": [phase_min, phase_max],
            "dc_offset_limit": dc_limit
        },
        "enforcement": {
            "regain_recommended": bool(regain_needed),
            "regain_gain_db": round(float(regain_gain_db), 2),
            "regain_reason": regain_reason,
            # Section 5 sets a second, lower phase threshold for the
            # mono-incompatibility warning than the compliance band's floor.
            "mono_incompatible": bool(phase_correlation < SPEC_PHASE_WARN)
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

    if not SCIPY_AVAILABLE:
        # The pipeline's QC gate blocks uploads on this verdict, so a degraded
        # measurement is not a cosmetic issue - it decides whether a master ships.
        print("[WARNING] scipy is not installed. Loudness is unweighted and peak")
        print("          is sample-peak, not true-peak. The QC gate is deciding")
        print("          on degraded numbers. Install scipy before trusting this.")
        print("----------------------------------------------------------------")
    print(f"Master File : {report['master_file']} ({report['bit_depth']}-bit / {fr} Hz / {duration_sec}s)")
    print(f"Loudness    : {m['integrated_lufs']} LUFS  (LRA {m['loudness_range_lu']} LU)")
    print(f"              method: {m['lufs_method']}")
    print(f"True Peak   : {m['true_peak_dbtp']} dBTP  (sample peak {m['sample_peak_dbfs']} dBFS)")
    print(f"              method: {m['true_peak_method']}")
    print(f"Dynamics    : {m['crest_factor_db']} dB crest factor")
    print(f"Phase Coeff : {m['stereo_phase_correlation']}")
    print(f"DC Offset   : L {m['dc_offset']['left']}  R {m['dc_offset']['right']}")
    print("----------------------------------------------------------------")
    print(f"  true peak <= {true_peak_ceiling} dBTP        : {'PASS' if c['true_peak_safety_met'] else 'FAIL'}")
    print(f"  phase in [{phase_min}, {phase_max}]        : {'PASS' if c['phase_compatibility_met'] else 'FAIL'}")
    print(f"  DC offset < {dc_limit}         : {'PASS' if c['dc_offset_clean'] else 'FAIL'}")
    print(f"  loudness in [{target_lufs_min}, {target_lufs_max}]  : "
          f"{'PASS' if c['streaming_target_met'] else 'outside window (informational)'}")

    e = report["enforcement"]
    if e["regain_recommended"]:
        print(f"  re-gain              : {e['regain_gain_db']:+.2f} dB - {e['regain_reason']}")
        print(f"                         (apply with --apply-gain)")
    else:
        print(f"  re-gain              : not needed - {e['regain_reason']}")

    if e["mono_incompatible"]:
        print(f"  [WARN] phase {m['stereo_phase_correlation']} is below {SPEC_PHASE_WARN}: "
              f"this master will partially cancel on a mono speaker.")
    print("----------------------------------------------------------------")
    print(f"QC VERDICT  : {'[PASS]' if c['overall_qc_passed'] else '[FAIL]'}")
    print(f"Report      : {report_out}")
    print("================================================================")

    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 audio QC analyzer")
    parser.add_argument("--wav-path", required=True, help="Path to master WAV file")
    parser.add_argument("--report-out", default=None, help="Override report JSON path")
    # Derived from the spec constants rather than restated. Hardcoding these
    # separately is how the CLI drifted from the function defaults: the window
    # was [-16, -9], so --apply-gain re-gained to its midpoint of -12.5 instead
    # of the -14.0 target.
    parser.add_argument("--lufs-min", type=float,
                        default=SPEC_LUFS_TARGET - SPEC_LUFS_TOLERANCE)
    parser.add_argument("--lufs-max", type=float,
                        default=SPEC_LUFS_TARGET + SPEC_LUFS_TOLERANCE)
    parser.add_argument("--true-peak-ceiling", type=float, default=SPEC_TRUE_PEAK_CEILING)
    parser.add_argument("--fail-on-loudness", action="store_true",
                        help="Also gate the exit code on the loudness window")
    parser.add_argument("--apply-gain", action="store_true",
                        help="Re-gain the master toward target when deviation exceeds "
                             "1.5 LU, then re-measure (spec section 5 enforcement)")
    parser.add_argument("--genre", default=None,
                        help="Apply a genre compliance profile: rap, distorted_rock, "
                             "space_trippy, or an alias. Overrides the threshold defaults.")
    parser.add_argument("--list-profiles", action="store_true",
                        help="Print the genre compliance matrix and exit")
    args = parser.parse_args()

    if args.list_profiles:
        header = (f"{'profile':<16}{'LUFS window':>18}{'true peak':>13}"
                  f"{'phase band':>14}{'crest factor':>16}")
        print(header)
        print("-" * len(header))

        for name, p in GENRE_COMPLIANCE.items():
            lufs = f"{p['lufs_min']} to {p['lufs_max']}"
            peak = f"{p['true_peak_ceiling']} dBTP"
            phase = f"{p['phase_min']} to {p['phase_max']}"
            crest = ("n/a" if p["crest_min"] is None
                     else f"{p['crest_min']} to {p['crest_max']} dB")
            print(f"{name:<16}{lufs:>18}{peak:>13}{phase:>14}{crest:>16}")

        print()
        print("aliases:")
        for alias, target in sorted(GENRE_ALIASES.items()):
            print(f"  {alias:<26} -> {target}")
        sys.exit(0)

    # A genre profile supplies every threshold, so it overrides the individual
    # flags rather than being merged with them.
    phase_min = SPEC_PHASE_MIN
    phase_max = SPEC_PHASE_MAX
    dc_limit = SPEC_DC_LIMIT

    if args.genre:
        profile, resolved = resolve_compliance(args.genre)
        print(f"[QC] Compliance profile: {resolved}")
        args.lufs_min = profile["lufs_min"]
        args.lufs_max = profile["lufs_max"]
        args.true_peak_ceiling = profile["true_peak_ceiling"]
        phase_min = profile["phase_min"]
        phase_max = profile["phase_max"]
        dc_limit = profile["dc_limit"]

    rep = analyze_master_qc(
        args.wav_path,
        target_lufs_min=args.lufs_min,
        target_lufs_max=args.lufs_max,
        true_peak_ceiling=args.true_peak_ceiling,
        phase_min=phase_min,
        phase_max=phase_max,
        dc_limit=dc_limit,
        report_out=args.report_out
    )

    if args.apply_gain and rep["enforcement"]["regain_recommended"]:
        gain_db = rep["enforcement"]["regain_gain_db"]
        print(f"\n[RE-GAIN] Applying {gain_db:+.2f} dB and re-measuring...")

        data, fr, sw, n_ch, _ = read_wav(args.wav_path)
        adjusted = data * dbfs_to_linear_scalar(gain_db)

        # Re-limit after gain: raising level can create new inter-sample
        # overshoot even when the planned gain respected the measured peak.
        adjusted = apply_ceiling_clamp(adjusted, true_peak_ceiling=args.true_peak_ceiling)

        write_wav(args.wav_path, adjusted, fr, sw)
        print(f"[RE-GAIN] Rewrote {args.wav_path}")

        rep = analyze_master_qc(
            args.wav_path,
            target_lufs_min=args.lufs_min,
            target_lufs_max=args.lufs_max,
            true_peak_ceiling=args.true_peak_ceiling,
            phase_min=phase_min,
            phase_max=phase_max,
            dc_limit=dc_limit,
            report_out=args.report_out
        )

    ok = rep["compliance"]["overall_qc_passed"]
    if args.fail_on_loudness:
        ok = ok and rep["compliance"]["streaming_target_met"]

    sys.exit(0 if ok else 1)
