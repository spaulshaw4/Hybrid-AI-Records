# D:\MusicDatasets\scripts\entangled_pattern_engine.py
"""
===============================================================================
HYBRID 1.0 - CROSS-TRACK STATE COUPLING MATRIX
===============================================================================
Deterministic coupling between paired stems, applied on the raw sample arrays
during the binary frame pass. Two modes:

  anti_phase_duck      Kick transients suppress sub-bass energy at the same
                       frames, so the low end reads as one source instead of
                       two fighting for the same octave.

  reciprocal_mid_side  Lead vocal centre energy carves the harmonic bed's mid
                       channel and pushes it outward, opening a vocal pocket
                       that closes again during instrumental sections.

Both are sidechain techniques computed offline over whole buffers, so the
envelope is non-causal by design: it can see the transient before it lands,
which a realtime sidechain cannot. That is an advantage here, not a compromise.

Envelope smoothing uses a cumulative-sum moving average rather than convolution
- same result, roughly 3x faster, and it keeps the window exactly centred.
"""

import os
import sys
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

DEFAULT_SAMPLE_RATE = 44100
DEFAULT_ENVELOPE_MS = 5.0

# Floor for the mid-carve. Allowing the mask to reach zero would fully mute the
# harmonic bed's centre under a loud vocal, which collapses the arrangement
# rather than making space in it.
MID_CARVE_FLOOR = 0.1


def align_lengths(a: np.ndarray, b: np.ndarray):
    """
    Zero-pad the shorter buffer so elementwise coupling is valid.

    Without this, coupling a 2-second kick against an 8-second sub raises a
    broadcast error, or worse, silently truncates the sub if the caller slices
    to the shorter length.
    """
    if len(a) == len(b):
        return a, b

    target = max(len(a), len(b))
    pad = lambda x: np.pad(x, ((0, target - len(x)), (0, 0)), mode="constant")
    return (pad(a) if len(a) < target else a,
            pad(b) if len(b) < target else b)


def moving_average(x: np.ndarray, window: int) -> np.ndarray:
    """Centred moving average via cumulative sum. Returns the input length."""
    if window < 2 or len(x) < window:
        return x

    # Reflect-pad so the envelope does not dip toward zero at the edges, which
    # would let a transient sitting at the very start of a slice escape ducking.
    half = window // 2
    padded = np.concatenate((x[half:0:-1], x, x[-2:-half - 2:-1]))

    cumsum = np.cumsum(np.concatenate(([0.0], padded)))
    smoothed = (cumsum[window:] - cumsum[:-window]) / float(window)

    if len(smoothed) >= len(x):
        return smoothed[:len(x)]
    return np.pad(smoothed, (0, len(x) - len(smoothed)), mode="edge")


class EntangledPatternMatrix:
    def __init__(self, sample_rate=DEFAULT_SAMPLE_RATE, envelope_ms=DEFAULT_ENVELOPE_MS):
        self.sample_rate = sample_rate
        self.envelope_ms = envelope_ms
        self.applied = []

    def envelope_window(self) -> int:
        return max(2, int(self.sample_rate * (self.envelope_ms / 1000.0)))

    def couple_foundation_pair(self, kick_buf, sub_buf, coupling_coeff=0.85):
        """
        Kick transients duck the sub-bass.

        The mask is |k|/(1+|k|), which saturates toward 1 rather than growing
        without bound, so a hot kick cannot drive the sub negative. coupling_coeff
        sets how much of that range is used.
        """
        kick_buf, sub_buf = align_lengths(kick_buf, sub_buf)

        kick_env = np.abs(np.mean(kick_buf, axis=1))
        kick_env = moving_average(kick_env, self.envelope_window())

        mask = 1.0 - (coupling_coeff * (kick_env / (1.0 + kick_env)))
        mask = np.clip(mask, 0.0, 1.0)[:, None]

        sub_before = float(np.sqrt(np.mean(sub_buf ** 2)))
        coupled_sub = sub_buf * mask
        sub_after = float(np.sqrt(np.mean(coupled_sub ** 2)))

        self.applied.append({
            "mode": "anti_phase_duck",
            "coefficient": coupling_coeff,
            "sub_rms_before": round(sub_before, 6),
            "sub_rms_after": round(sub_after, 6),
            "max_duck_db": round(float(20.0 * np.log10(max(mask.min(), 1e-9))), 2)
        })

        return kick_buf, coupled_sub

    def couple_harmonic_spatial_pair(self, lead_buf, harmonics_buf, coupling_coeff=0.60):
        """
        Lead centre energy carves the harmonic mid and widens the side.

        Mid/side is exact here: mid=(L+R)/2, side=(L-R)/2, reconstructing as
        L=mid+side, R=mid-side. With no modulation this round-trips to the
        original signal, so the only change is the intended one.
        """
        lead_buf, harmonics_buf = align_lengths(lead_buf, harmonics_buf)

        mid = 0.5 * (harmonics_buf[:, 0] + harmonics_buf[:, 1])
        side = 0.5 * (harmonics_buf[:, 0] - harmonics_buf[:, 1])

        lead_center = np.abs(0.5 * (lead_buf[:, 0] + lead_buf[:, 1]))
        lead_center = moving_average(lead_center, self.envelope_window())

        carve = 1.0 - (coupling_coeff * (lead_center / (1.0 + lead_center)))
        carve = np.clip(carve, MID_CARVE_FLOOR, 1.0)

        coupled_mid = mid * carve
        # Side gain rises as the mid is carved, so total energy stays closer to
        # constant instead of the bed simply getting quieter under the vocal.
        coupled_side = side * (1.0 + (0.5 * coupling_coeff * (1.0 - carve)))

        coupled = np.column_stack((coupled_mid + coupled_side,
                                   coupled_mid - coupled_side))

        self.applied.append({
            "mode": "reciprocal_mid_side",
            "coefficient": coupling_coeff,
            "max_mid_carve_db": round(float(20.0 * np.log10(max(carve.min(), 1e-9))), 2),
            "max_side_boost_db": round(float(20.0 * np.log10(
                1.0 + 0.5 * coupling_coeff * (1.0 - carve.min()))), 2)
        })

        return lead_buf, coupled

    def process_entangled_pairs(self, registered_buffers: dict, pair_definitions: list) -> dict:
        """
        Apply every defined pair to a name-keyed buffer registry.

        Pairs whose stems are not both present are reported rather than skipped
        silently: a typo in a recipe's entangled_pairs would otherwise produce a
        master with no coupling and no indication why.
        """
        handlers = {
            "anti_phase_duck": self.couple_foundation_pair,
            "reciprocal_mid_side": self.couple_harmonic_spatial_pair,
        }

        for pair in pair_definitions or []:
            primary = pair.get("primary_stem")
            coupled = pair.get("coupled_stem")
            mode = pair.get("coupling_mode")
            coeff = float(pair.get("coupling_coefficient", 0.75))
            pair_id = pair.get("pair_id", "unnamed")

            handler = handlers.get(mode)
            if handler is None:
                print(f"  [COUPLING] {pair_id}: unknown mode '{mode}', skipped")
                continue

            missing = [n for n in (primary, coupled) if n not in registered_buffers]
            if missing:
                print(f"  [COUPLING] {pair_id}: stem(s) not registered: {', '.join(missing)}")
                continue

            registered_buffers[primary], registered_buffers[coupled] = handler(
                registered_buffers[primary], registered_buffers[coupled], coeff
            )
            print(f"  [COUPLING] {pair_id}: {mode} at {coeff} "
                  f"({primary} -> {coupled})")

        return registered_buffers

    def summary(self):
        return {"pairs_applied": len(self.applied), "detail": self.applied}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Hybrid 1.0 cross-track coupling matrix")
    parser.add_argument("--self-test", action="store_true",
                        help="Run a measurable check that coupling does what it claims")
    args = parser.parse_args()

    if not args.self_test:
        print("This module is a library. Run with --self-test to verify behaviour.")
        sys.exit(0)

    SR = DEFAULT_SAMPLE_RATE
    matrix = EntangledPatternMatrix(sample_rate=SR)

    print("=== anti_phase_duck: does a kick measurably duck the sub? ===")
    n = SR * 4
    t = np.arange(n) / SR

    # Kick on every beat at 120 BPM, sub sustained underneath
    kick = np.zeros(n, dtype=np.float64)
    for start in range(0, n - SR // 4, SR // 2):
        ht = np.arange(SR // 4) / SR
        kick[start:start + SR // 4] += 0.9 * np.sin(2 * np.pi * 60 * ht) * np.exp(-ht * 14)

    sub = 0.5 * np.sin(2 * np.pi * 55 * t)

    kick_st = np.column_stack((kick, kick))
    sub_st = np.column_stack((sub, sub))

    _, ducked = matrix.couple_foundation_pair(kick_st, sub_st, 0.85)

    # Explicit frame windows rather than percentiles: hits land every SR//2
    # frames and decay over SR//4, so a percentile split can select an empty
    # set when the envelope floor is flat, which reports NaN instead of a result.
    hit_window = slice(500, 4000)          # inside the first kick's decay
    gap_window = slice(15000, 21000)       # after it, before the next

    before_loud = np.sqrt(np.mean(sub_st[hit_window] ** 2))
    after_loud = np.sqrt(np.mean(ducked[hit_window] ** 2))
    before_quiet = np.sqrt(np.mean(sub_st[gap_window] ** 2))
    after_quiet = np.sqrt(np.mean(ducked[gap_window] ** 2))

    print(f"  during kick hits : sub {20*np.log10(before_loud):.2f} -> "
          f"{20*np.log10(after_loud):.2f} dB "
          f"({20*np.log10(after_loud/before_loud):+.2f} dB)")
    print(f"  between hits     : sub {20*np.log10(before_quiet):.2f} -> "
          f"{20*np.log10(after_quiet):.2f} dB "
          f"({20*np.log10(after_quiet/before_quiet):+.2f} dB)")

    duck_delta = 20*np.log10(after_loud/before_loud) - 20*np.log10(after_quiet/before_quiet)
    print(f"  selective ducking: {duck_delta:.2f} dB more attenuation under hits")
    print(f"  -> {'WORKS' if duck_delta < -1.0 else 'NOT SELECTIVE'}")

    print("\n=== reciprocal_mid_side: does a vocal widen the bed? ===")
    vox = np.zeros(n, dtype=np.float64)
    vox[SR:SR * 3] = 0.6 * np.sin(2 * np.pi * 440 * t[SR:SR * 3])
    vox_st = np.column_stack((vox, vox))

    gl = 0.4 * np.sin(2 * np.pi * 330 * t)
    gr = 0.4 * np.sin(2 * np.pi * 330 * t + 0.4)
    gtr_st = np.column_stack((gl, gr))

    _, widened = matrix.couple_harmonic_spatial_pair(vox_st, gtr_st, 0.60)

    def correlation(x):
        a, b = x[:, 0], x[:, 1]
        d = np.sqrt(np.sum(a ** 2) * np.sum(b ** 2)) + 1e-12
        return float(np.sum(a * b) / d)

    vocal_on = slice(SR, SR * 3)
    vocal_off = slice(SR * 3, n)

    print(f"  vocal present : L/R correlation {correlation(gtr_st[vocal_on]):.4f} -> "
          f"{correlation(widened[vocal_on]):.4f}")
    print(f"  vocal absent  : L/R correlation {correlation(gtr_st[vocal_off]):.4f} -> "
          f"{correlation(widened[vocal_off]):.4f}")

    on_delta = correlation(widened[vocal_on]) - correlation(gtr_st[vocal_on])
    off_delta = correlation(widened[vocal_off]) - correlation(gtr_st[vocal_off])
    print(f"  widening is conditional: {on_delta:.4f} under vocal vs "
          f"{off_delta:.4f} without")
    print(f"  -> {'WORKS' if on_delta < off_delta - 0.001 else 'NOT CONDITIONAL'}")

    print("\n=== length mismatch handling ===")
    short = np.column_stack((np.ones(1000), np.ones(1000)))
    long = np.column_stack((np.ones(5000), np.ones(5000)))
    try:
        a, b = matrix.couple_foundation_pair(short, long, 0.5)
        print(f"  1000 vs 5000 frames -> coupled to {len(a)} / {len(b)}, no error")
    except Exception as e:
        print(f"  FAILED: {type(e).__name__}: {e}")

    print("\n=== summary ===")
    s = matrix.summary()
    print(f"  pairs applied: {s['pairs_applied']}")
    for d in s["detail"]:
        print(f"    {d}")
