"""
Three checks:

  1. DC blocking on the asymmetric drive - does it kill the +0.053 offset while
     keeping the even harmonics that justify the curve?
  2. Crest factor vs PLR - these are different metrics, and the genre bands were
     written against one of them. Which?
  3. The ambient phase fixture - does mid-plus-independent-noise land near 0.20,
     below the 0.25 default floor and above the 0.15 space_trippy floor?
"""

import os
import sys
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from hybrid_dsp import apply_asymmetric_drive
from audio_qc_analyzer import (compute_integrated_lufs, compute_true_peak_dbtp,
                               compute_phase_correlation, GENRE_COMPLIANCE)

SR = 44100


def harmonic_db(sig, f0, order):
    windowed = sig * np.hanning(len(sig))
    spec = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(sig), 1.0 / SR)

    def peak_near(f):
        i = np.argmin(np.abs(freqs - f))
        return spec[max(0, i - 3):i + 4].max()

    return 20.0 * np.log10(peak_near(f0 * order) / (peak_near(f0) + 1e-12) + 1e-12)


def generate_ambient_phase_fixture(duration_sec=3.0, mid_amp=0.3, noise_sigma=0.4, seed=5):
    """
    Correlated mid plus independent per-channel noise.

    Expected correlation is var_mid / (var_mid + var_noise). With mid_amp 0.3
    (variance 0.045) and sigma 0.4 (variance 0.16) that predicts about 0.22.
    """
    rng = np.random.default_rng(seed)
    n = int(SR * duration_sec)
    t = np.arange(n) / SR

    mid = mid_amp * np.sin(2 * np.pi * 440.0 * t)
    left = mid + rng.normal(0, noise_sigma, n)
    right = mid + rng.normal(0, noise_sigma, n)

    fixture = np.column_stack((left, right))
    return (fixture / np.max(np.abs(fixture)) * 0.7).astype(np.float32)


def main():
    print("=" * 72)
    print("1. DC blocking on the asymmetric drive")
    print("=" * 72)

    t = np.arange(int(SR * 2.0)) / SR
    x = 0.7 * np.sin(2 * np.pi * 500.0 * t)
    stereo = np.column_stack((x, x)).astype(np.float32)

    raw_x = stereo * 1.4
    raw = ((raw_x + 0.2 * raw_x ** 2) / (1.0 + np.abs(raw_x))).astype(np.float32)
    blocked = apply_asymmetric_drive(stereo, drive=1.4)

    print(f"  {'':<22}{'DC offset':>14}{'2nd harm':>12}{'3rd harm':>12}")
    for label, sig in (("without DC block", raw), ("with DC block", blocked)):
        dc = float(np.mean(sig[:, 0]))
        h2 = harmonic_db(sig[:, 0], 500.0, 2)
        h3 = harmonic_db(sig[:, 0], 500.0, 3)
        print(f"  {label:<22}{dc:>+14.8f}{h2:>+11.2f}dB{h3:>+11.2f}dB")

    dc_after = abs(float(np.mean(blocked[:, 0])))
    h2_after = harmonic_db(blocked[:, 0], 500.0, 2)
    print()
    print(f"  DC now {dc_after:.2e}, limit is 1.0e-04 -> "
          f"{'PASSES' if dc_after < 1e-4 else 'STILL FAILS'}")
    print(f"  even harmonics retained at {h2_after:+.2f} dB -> "
          f"{'preserved' if h2_after > -40 else 'LOST'}")

    print()
    print("=" * 72)
    print("2. Crest factor vs PLR - not the same metric")
    print("=" * 72)
    print()
    print("  crest factor = sample peak - RMS")
    print("  PLR          = true peak  - integrated LUFS")
    print()
    print(f"  {'test signal':<26}{'crest':>9}{'PLR':>9}{'gap':>8}")

    rng = np.random.default_rng(3)
    cases = {}

    # Dense, limited: approximates a loud modern master
    dense = np.tanh(rng.standard_normal((SR * 3, 2)) * 3.0) * 0.9
    cases["dense limited"] = dense.astype(np.float32)

    # Sparse transients over a quiet bed: high dynamic range
    sparse = (rng.standard_normal((SR * 3, 2)) * 0.02)
    for hit in range(0, SR * 3, SR // 2):
        L = min(2000, len(sparse) - hit)
        sparse[hit:hit + L] += (np.exp(-np.arange(L) / 300.0) * 0.85)[:, None]
    cases["sparse transients"] = sparse.astype(np.float32)

    # Steady tone
    cases["steady sine"] = np.column_stack((0.7 * np.sin(2 * np.pi * 220 * t),) * 2).astype(np.float32)

    for label, sig in cases.items():
        peak = float(np.max(np.abs(sig)))
        peak_db = 20 * np.log10(peak + 1e-12)
        rms_db = 20 * np.log10(float(np.sqrt(np.mean(sig ** 2))) + 1e-12)
        crest = peak_db - rms_db

        lufs, _, _ = compute_integrated_lufs(sig.astype(np.float64), SR)
        tp, _ = compute_true_peak_dbtp(sig.astype(np.float64), SR)
        plr = tp - lufs

        print(f"  {label:<26}{crest:>8.2f}{plr:>9.2f}{plr - crest:>+8.2f}")

    print()
    print("  The two differ by 2-4 dB because LUFS is K-weighted and gated while")
    print("  RMS is neither. A band written for one metric misjudges the other.")
    print()
    print("  Genre bands as specified:")
    for name, p in GENRE_COMPLIANCE.items():
        if p["crest_min"] is not None:
            print(f"    {name:<16} {p['crest_min']} to {p['crest_max']} dB")

    print()
    print("=" * 72)
    print("3. Ambient phase fixture")
    print("=" * 72)

    fixture = generate_ambient_phase_fixture()
    measured = compute_phase_correlation(fixture.astype(np.float64))

    var_mid = (0.3 ** 2) / 2.0
    var_noise = 0.4 ** 2
    predicted = var_mid / (var_mid + var_noise)

    default_floor = GENRE_COMPLIANCE["default"]["phase_min"]
    ambient_floor = GENRE_COMPLIANCE["space_trippy"]["phase_min"]

    print()
    print(f"  predicted correlation : {predicted:.4f}  (var_mid / (var_mid + var_noise))")
    print(f"  measured correlation  : {measured:.4f}")
    print()
    print(f"  default floor {default_floor}  -> {'PASS' if measured >= default_floor else 'FAIL'}")
    print(f"  space_trippy floor {ambient_floor} -> {'PASS' if measured >= ambient_floor else 'FAIL'}")

    rescued = measured < default_floor and measured >= ambient_floor
    print()
    print(f"  demonstrates the ambient rescue case: {rescued}")

    return 0 if (dc_after < 1e-4 and h2_after > -40 and rescued) else 1


if __name__ == "__main__":
    sys.exit(main())
