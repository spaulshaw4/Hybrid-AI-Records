"""
Measures the error in approximating integrated LUFS as RMS_dBFS - 3.0.

The foundry daemon's QC uses that approximation and then gates uploads on the
result. This checks how far it lands from a real K-weighted gated measurement
across signals of different spectral content, since the K-weighting curve is
frequency dependent and a flat offset cannot track it.

Also compares sample peak against true peak, because the same function tests a
sample-peak value against a true-peak ceiling.
"""

import os
import sys
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from audio_qc_analyzer import compute_integrated_lufs, compute_true_peak_dbtp

SR = 44100
DURATION = 4.0


def rms_dbfs(sig):
    return 20.0 * np.log10(float(np.sqrt(np.mean(sig ** 2))) + 1e-12)


def approx_lufs(sig):
    """The daemon's approximation."""
    return rms_dbfs(sig) - 3.0


def stereo(mono):
    return np.column_stack((mono, mono)).astype(np.float64)


def main():
    t = np.arange(int(SR * DURATION)) / SR
    rng = np.random.default_rng(11)

    cases = {}

    # K-weighting is roughly flat near 1-2 kHz, boosts above 2 kHz, and cuts
    # sharply below 100 Hz. Spectral content should therefore drive the error.
    for freq in (50, 100, 400, 1000, 3000, 8000, 14000):
        cases[f"sine {freq} Hz"] = stereo(0.4 * np.sin(2 * np.pi * freq * t))

    cases["white noise"] = stereo(rng.standard_normal(len(t)) * 0.15)

    pink = np.cumsum(rng.standard_normal(len(t)))
    pink = pink / (np.max(np.abs(pink)) + 1e-12) * 0.5
    cases["pink-ish noise"] = stereo(pink)

    # Bass-heavy, like a Q1 foundation bus
    bass = 0.5 * np.sin(2 * np.pi * 55 * t) + 0.2 * np.sin(2 * np.pi * 110 * t)
    cases["bass heavy"] = stereo(bass)

    # Bright, like a Q3 top bus
    bright = 0.3 * np.sin(2 * np.pi * 6000 * t) + 0.2 * rng.standard_normal(len(t))
    cases["bright / airy"] = stereo(bright * 0.6)

    print("Integrated LUFS: real BS.1770 vs RMS - 3.0")
    print()
    print(f"  {'signal':<18}{'real LUFS':>11}{'approx':>10}{'error':>9}")
    print("  " + "-" * 48)

    errors = []
    for label, sig in cases.items():
        real, _, method = compute_integrated_lufs(sig, SR)
        approx = approx_lufs(sig)
        err = approx - real
        errors.append((label, err))
        print(f"  {label:<18}{real:>10.2f} {approx:>9.2f} {err:>+8.2f}")

    abs_errors = [abs(e) for _, e in errors]
    worst_label, worst_err = max(errors, key=lambda x: abs(x[1]))

    print()
    print(f"  mean absolute error : {np.mean(abs_errors):.2f} dB")
    print(f"  worst               : {worst_err:+.2f} dB on '{worst_label}'")
    print(f"  spread              : {max(e for _, e in errors) - min(e for _, e in errors):.2f} dB")
    print()
    print("  The error tracks spectral content, which is the point: K-weighting")
    print("  cuts below 100 Hz and lifts above 2 kHz, so no fixed offset fits")
    print("  both a sub-bass bus and an airy top bus.")

    print()
    print("=" * 60)
    print("Sample peak vs true peak against a true-peak ceiling")
    print()
    print(f"  {'signal':<18}{'sample':>10}{'true':>9}{'under by':>10}")
    print("  " + "-" * 47)

    # Inter-sample overshoot: alternating polarity at a fraction of Nyquist
    peaky = np.zeros(2000)
    peaky[::4] = 0.94
    peaky[1::4] = -0.94
    tp_cases = {
        "alternating +/-": stereo(peaky),
        "sine 7 kHz": stereo(0.94 * np.sin(2 * np.pi * 7000 * t)),
        "sine 220 Hz": stereo(0.94 * np.sin(2 * np.pi * 220 * t)),
    }

    worst_gap = 0.0
    for label, sig in tp_cases.items():
        sp = 20.0 * np.log10(float(np.max(np.abs(sig))) + 1e-12)
        tp, _ = compute_true_peak_dbtp(sig, SR)
        gap = tp - sp
        worst_gap = max(worst_gap, gap)
        print(f"  {label:<18}{sp:>9.2f} {tp:>8.2f} {gap:>+9.2f}")

    print()
    print(f"  worst underestimate: {worst_gap:+.2f} dB")
    print("  A sample-peak value tested against a true-peak ceiling passes")
    print("  masters that actually breach it by that margin.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
