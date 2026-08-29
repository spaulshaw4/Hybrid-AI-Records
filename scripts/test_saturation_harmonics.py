"""
Checks the Cortex claim that tanh yields only odd harmonics while the
asymmetric curve f(x) = (x + 0.2x^2) / (1 + |x|) introduces even orders.

Measured on a single sine so harmonic order is unambiguous.
"""

import sys
import numpy as np

SR = 44100
F0 = 500.0
DURATION = 2.0


def tanh_drive(x, drive=1.4):
    return np.tanh(x * drive)


def asymmetric_drive(x, drive=1.4):
    xd = x * drive
    return (xd + 0.2 * (xd ** 2)) / (1.0 + np.abs(xd))


def harmonic_levels(sig, n_harmonics=8):
    """Return dB of each harmonic relative to the fundamental."""
    windowed = sig * np.hanning(len(sig))
    spec = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(sig), 1.0 / SR)

    def peak_near(f):
        idx = np.argmin(np.abs(freqs - f))
        return spec[max(0, idx - 3):idx + 4].max()

    fundamental = peak_near(F0)
    return [20.0 * np.log10(peak_near(F0 * n) / (fundamental + 1e-12) + 1e-12)
            for n in range(1, n_harmonics + 1)]


def dc_offset(sig):
    return float(np.mean(sig))


def main():
    t = np.arange(int(SR * DURATION)) / SR
    x = 0.7 * np.sin(2.0 * np.pi * F0 * t)

    print(f"Input: {F0:.0f} Hz sine at {20*np.log10(0.7):.2f} dBFS, drive 1.4")
    print()

    results = {}
    for label, fn in (("tanh (odd only)", tanh_drive),
                      ("asymmetric (even+odd)", asymmetric_drive)):
        out = fn(x)
        results[label] = out
        levels = harmonic_levels(out)

        print(f"  {label}")
        print(f"    {'harmonic':>10}  {'freq':>8}  {'level':>10}  {'parity':>7}")
        for n, lvl in enumerate(levels, start=1):
            parity = "odd" if n % 2 else "EVEN"
            print(f"    {n:>10}  {F0*n:>7.0f}  {lvl:>+9.2f} dB  {parity:>7}")

        evens = [levels[n - 1] for n in range(2, 9) if n % 2 == 0]
        odds = [levels[n - 1] for n in range(3, 9) if n % 2]

        print(f"    strongest even harmonic: {max(evens):+.2f} dB")
        print(f"    strongest odd  harmonic: {max(odds):+.2f} dB")
        print(f"    DC offset: {dc_offset(out):+.6f}")
        print()

    tanh_levels = harmonic_levels(results["tanh (odd only)"])
    asym_levels = harmonic_levels(results["asymmetric (even+odd)"])

    tanh_2nd = tanh_levels[1]
    asym_2nd = asym_levels[1]

    print("=" * 66)
    print(f"2nd harmonic: tanh {tanh_2nd:+.2f} dB, asymmetric {asym_2nd:+.2f} dB")
    print(f"  difference: {asym_2nd - tanh_2nd:+.2f} dB")
    print()

    claim_holds = (tanh_2nd < -60.0) and (asym_2nd > -40.0)
    print(f"Claim verified: {claim_holds}")
    print("  tanh is an odd function, so f(-x) = -f(x) and even orders cancel.")
    print("  The x^2 term breaks that symmetry, producing even harmonics and a")
    print("  DC offset which must be removed before summing.")

    return 0 if claim_holds else 1


if __name__ == "__main__":
    sys.exit(main())
