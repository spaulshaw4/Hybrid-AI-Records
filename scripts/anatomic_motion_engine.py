# D:\MusicDatasets\scripts\anatomic_motion_engine.py
"""
===============================================================================
HYBRID 1.0 - ANATOMIC & BIOMECHANICAL MOTION ENGINE
===============================================================================
Translates physiological rhythms into sample-accurate frame automation vectors.

  respiration    Asymmetric tidal envelope. Inhalation is active muscular work
                 (~40% of cycle), exhalation is passive elastic recoil (~60%),
                 so the curve is deliberately not a sine.

  cardiac_pulse  Two-stage systolic impulse with a dicrotic notch from aortic
                 valve closure - the secondary rebound that makes a pulse read
                 as a heartbeat rather than a click.

  joint_flexion  Minimum-jerk trajectory (10t^3 - 15t^4 + 6t^5), the standard
                 model for how a limb actually accelerates and decelerates
                 through an arc. Zero velocity and acceleration at both ends.

  gait_cycle     Bilateral stance/swing ground-reaction forces, left and right
                 a half-stride out of phase.

Output convention
-----------------
Every generator returns a vector scaled to [min_val, max_val], so the caller
maps physiology onto whatever the target parameter needs - a cutoff in Hz, a
width multiplier, a gain coefficient. Normalising to a fixed [0, 1] internally
would mean callers had to rescale twice and would silently clip any parameter
whose useful range sits outside it.
"""

import os
import sys
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

DEFAULT_SAMPLE_RATE = 44100

ANATOMIC_MODELS = ("respiration", "cardiac_pulse", "joint_flexion", "gait_cycle")


class AnatomicMotionEngine:
    def __init__(self, sample_rate: int = DEFAULT_SAMPLE_RATE):
        self.sample_rate = sample_rate

    def _phase(self, length_samples: int, period_sec: float):
        """Cyclic phase in [0,1). Built from a sample index, not accumulated
        time, so a long vector cannot drift against the frame grid."""
        n = np.arange(length_samples, dtype=np.float64)
        period_samples = max(1.0, period_sec * self.sample_rate)
        return (n % period_samples) / period_samples

    def generate_respiration(self, length_samples: int, breaths_per_minute: float = 14.0,
                             inhale_ratio: float = 0.40, min_val: float = 0.0,
                             max_val: float = 1.0) -> np.ndarray:
        if length_samples <= 0:
            return np.array([], dtype=np.float32)

        inhale_ratio = float(np.clip(inhale_ratio, 0.05, 0.95))
        phase = self._phase(length_samples, 60.0 / max(0.1, breaths_per_minute))

        out = np.zeros(length_samples, dtype=np.float64)

        inhale = phase < inhale_ratio
        exhale = ~inhale

        # Active inhalation: power 1.5 gives the slow start and firm finish of
        # diaphragm contraction, rather than a symmetric sine.
        out[inhale] = np.sin((np.pi * phase[inhale]) / (2.0 * inhale_ratio)) ** 1.5

        # Passive exhalation: cosine fall against an exponential recoil. Both
        # terms are 1.0 at tau=0, which is exactly where inhalation peaks, so
        # the two halves join without a discontinuity.
        tau = (phase[exhale] - inhale_ratio) / (1.0 - inhale_ratio)
        out[exhale] = np.cos((np.pi * tau) / 2.0) * np.exp(-1.8 * tau)

        out = np.clip(out, 0.0, 1.0)
        return (min_val + (max_val - min_val) * out).astype(np.float32)

    def generate_cardiac_pulse(self, length_samples: int, heart_rate_bpm: float = 72.0,
                               dicrotic_notch_strength: float = 0.35,
                               diastolic_decay: float = 0.0,
                               min_val: float = 0.0, max_val: float = 1.0) -> np.ndarray:
        if length_samples <= 0:
            return np.array([], dtype=np.float32)

        phase = self._phase(length_samples, 60.0 / max(1.0, heart_rate_bpm))

        # Primary ventricular ejection
        systole = np.exp(-((phase - 0.12) ** 2) / (2 * (0.04 ** 2)))

        # Aortic valve closure rebound, later and broader than the systolic peak
        dicrotic = dicrotic_notch_strength * np.exp(-((phase - 0.28) ** 2) / (2 * (0.05 ** 2)))

        pulse = systole + dicrotic

        # The spec's formulation includes a diastolic baseline decay term.
        # Off by default because subtracting it drives the trough below zero,
        # which clips to silence for a gain target.
        if diastolic_decay > 0:
            pulse = pulse - diastolic_decay * np.exp(-phase / 0.35)

        pulse = np.clip(pulse, 0.0, 1.0)
        return (min_val + (max_val - min_val) * pulse).astype(np.float32)

    def generate_joint_flexion(self, length_samples: int, start_angle_deg: float = 0.0,
                               end_angle_deg: float = 140.0, tension_factor: float = 1.0,
                               min_val: float = 0.0, max_val: float = 1.0) -> np.ndarray:
        """
        Minimum-jerk articulation, scaled to [min_val, max_val].

        The angles set the shape's asymmetry, not the output range. Dividing the
        angle by 180 - as a literal reading of the model suggests - makes a
        0-140 degree flexion span only 0 to 0.778, and lets an end angle above
        180 exceed 1.0 entirely. The trajectory is therefore normalised against
        its own endpoints so the caller's min/max always hold.
        """
        if length_samples <= 0:
            return np.array([], dtype=np.float32)

        tau = np.linspace(0.0, 1.0, length_samples, endpoint=True, dtype=np.float64)

        trajectory = 10.0 * (tau ** 3) - 15.0 * (tau ** 4) + 6.0 * (tau ** 5)

        if tension_factor != 1.0:
            trajectory = trajectory ** max(0.01, tension_factor)

        angle = start_angle_deg + (end_angle_deg - start_angle_deg) * trajectory

        span = end_angle_deg - start_angle_deg
        if abs(span) < 1e-9:
            normalized = np.zeros_like(angle)
        else:
            normalized = (angle - start_angle_deg) / span

        normalized = np.clip(normalized, 0.0, 1.0)
        return (min_val + (max_val - min_val) * normalized).astype(np.float32)

    def generate_gait_cycle(self, length_samples: int, cadence_steps_per_min: float = 110.0,
                            stance_ratio: float = 0.60, min_val: float = 0.0,
                            max_val: float = 1.0):
        """Returns (left_force, right_force), a half-stride out of phase."""
        if length_samples <= 0:
            empty = np.array([], dtype=np.float32)
            return empty, empty

        stance_ratio = float(np.clip(stance_ratio, 0.05, 0.95))

        # A stride is two steps, hence 120 rather than 60
        stride_period = 120.0 / max(1.0, cadence_steps_per_min)
        stride_samples = max(1.0, stride_period * self.sample_rate)

        n = np.arange(length_samples, dtype=np.float64)
        left_phase = (n % stride_samples) / stride_samples
        right_phase = ((n + stride_samples / 2.0) % stride_samples) / stride_samples

        def ground_force(phase):
            # Inverted pendulum: force during stance, zero through swing
            return np.where(phase < stance_ratio,
                            np.sin((np.pi * phase) / stance_ratio), 0.0)

        left = np.clip(ground_force(left_phase), 0.0, 1.0)
        right = np.clip(ground_force(right_phase), 0.0, 1.0)

        scale = lambda x: (min_val + (max_val - min_val) * x).astype(np.float32)
        return scale(left), scale(right)

    # -----------------------------------------------------------------
    # Recipe resolution
    # -----------------------------------------------------------------

    def resolve_anatomic_motion(self, motion: dict, length_samples: int):
        """
        Build the vector for one anatomic_motions entry.

        Returns (vector, target_parameter). gait_cycle returns the left-foot
        vector; use generate_gait_cycle directly when both legs are needed.
        """
        model = motion.get("model")
        target = motion.get("target_parameter", "gain_linear")
        lo = float(motion.get("min_val", 0.0))
        hi = float(motion.get("max_val", 1.0))

        if model == "respiration":
            return self.generate_respiration(
                length_samples,
                breaths_per_minute=float(motion.get("breaths_per_minute", 14.0)),
                inhale_ratio=float(motion.get("inhale_ratio", 0.40)),
                min_val=lo, max_val=hi), target

        if model == "cardiac_pulse":
            return self.generate_cardiac_pulse(
                length_samples,
                heart_rate_bpm=float(motion.get("heart_rate_bpm", 72.0)),
                dicrotic_notch_strength=float(motion.get("dicrotic_notch_strength", 0.35)),
                diastolic_decay=float(motion.get("diastolic_decay", 0.0)),
                min_val=lo, max_val=hi), target

        if model == "joint_flexion":
            return self.generate_joint_flexion(
                length_samples,
                start_angle_deg=float(motion.get("start_angle_deg", 0.0)),
                end_angle_deg=float(motion.get("end_angle_deg", 140.0)),
                tension_factor=float(motion.get("tension_factor", 1.0)),
                min_val=lo, max_val=hi), target

        if model == "gait_cycle":
            left, _ = self.generate_gait_cycle(
                length_samples,
                cadence_steps_per_min=float(motion.get("cadence_steps_per_min", 110.0)),
                stance_ratio=float(motion.get("stance_ratio", 0.60)),
                min_val=lo, max_val=hi)
            return left, target

        return np.array([], dtype=np.float32), target


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Hybrid 1.0 anatomic motion engine")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if not args.self_test:
        print("This module is a library. Run with --self-test to verify behaviour.")
        sys.exit(0)

    SR = DEFAULT_SAMPLE_RATE
    eng = AnatomicMotionEngine(sample_rate=SR)

    print("=== respiration: asymmetry and continuity (12 bpm, 38% inhale) ===")
    # 5 second window covers one full 5s breath cycle at 12 bpm
    resp = eng.generate_respiration(SR * 5, breaths_per_minute=12.0,
                                    inhale_ratio=0.38, min_val=0.70, max_val=1.15)
    peak_idx = int(np.argmax(resp))
    peak_phase = (peak_idx % (SR * 5)) / (SR * 5)
    print(f"  range        : {resp.min():.4f} .. {resp.max():.4f}  (asked 0.70 .. 1.15)")
    print(f"  peak at phase: {peak_phase:.3f}  (inhale ends at 0.380)")
    jumps = np.abs(np.diff(resp))
    print(f"  max sample-to-sample jump: {jumps.max():.2e}  "
          f"-> {'continuous' if jumps.max() < 0.01 else 'DISCONTINUOUS'}")

    print("\n=== cardiac pulse: is the dicrotic notch a distinct second peak? ===")
    card = eng.generate_cardiac_pulse(SR * 2, heart_rate_bpm=140.0,
                                      dicrotic_notch_strength=0.40)
    one_beat = card[:int(SR * 60.0 / 140.0)]
    # Find local maxima
    peaks = [i for i in range(1, len(one_beat) - 1)
             if one_beat[i] > one_beat[i - 1] and one_beat[i] >= one_beat[i + 1]
             and one_beat[i] > 0.05]
    # Collapse adjacent indices into distinct peaks
    distinct = []
    for p in peaks:
        if not distinct or p - distinct[-1] > SR * 0.02:
            distinct.append(p)
    print(f"  distinct peaks in one beat: {len(distinct)}")
    for p in distinct[:4]:
        print(f"    phase {p / len(one_beat):.3f}  amplitude {one_beat[p]:.3f}")
    print(f"  -> {'systole + dicrotic present' if len(distinct) >= 2 else 'SINGLE PEAK ONLY'}")

    print("\n=== joint flexion: minimum-jerk properties ===")
    flex = eng.generate_joint_flexion(1000, start_angle_deg=15.0, end_angle_deg=165.0,
                                      tension_factor=1.0, min_val=0.0, max_val=1.0)
    vel = np.diff(flex)
    print(f"  endpoints     : {flex[0]:.6f} -> {flex[-1]:.6f}  (asked 0.0 -> 1.0)")
    print(f"  start velocity: {vel[0]:.3e}   end velocity: {vel[-1]:.3e}")
    print(f"  peak velocity at fraction {np.argmax(vel)/len(vel):.3f} (expect ~0.5)")
    print(f"  -> {'zero-velocity endpoints' if abs(vel[0]) < 1e-4 and abs(vel[-1]) < 1e-4 else 'NONZERO ENDPOINTS'}")

    print("\n  range holds regardless of angle span (the /180 issue):")
    for lo_a, hi_a in ((0.0, 140.0), (15.0, 165.0), (0.0, 270.0)):
        v = eng.generate_joint_flexion(500, lo_a, hi_a, min_val=0.0, max_val=1.0)
        print(f"    {lo_a:>5.0f} to {hi_a:>5.0f} deg -> output {v.min():.4f} .. {v.max():.4f}")

    print("\n=== gait cycle: bilateral phase opposition (128 steps/min) ===")
    left, right = eng.generate_gait_cycle(SR * 4, cadence_steps_per_min=128.0,
                                          stance_ratio=0.62)
    stride_samples = (120.0 / 128.0) * SR
    print(f"  stride period : {stride_samples/SR:.4f}s  ({stride_samples:.0f} frames)")
    print(f"  left  peak at frame {int(np.argmax(left[:int(stride_samples)]))}")
    print(f"  right peak at frame {int(np.argmax(right[:int(stride_samples)]))}")
    offset = abs(int(np.argmax(right[:int(stride_samples)])) -
                 int(np.argmax(left[:int(stride_samples)])))
    print(f"  peak separation: {offset} frames vs half-stride {stride_samples/2:.0f}")
    print(f"  -> {'out of phase' if abs(offset - stride_samples/2) < stride_samples*0.1 else 'PHASE ERROR'}")
    both_zero = np.mean((left == 0) & (right == 0))
    print(f"  double-swing (both feet airborne): {both_zero*100:.1f}% of cycle")
    print(f"     stance_ratio 0.62 per leg implies ~{max(0, (1-2*0.62))*100:.0f}% -> "
          f"{'walking, no float phase' if both_zero < 0.01 else 'running gait'}")

    print("\n=== recipe resolution ===")
    for m in [
        {"motion_id": "RESP_01", "model": "respiration", "target_parameter": "master_air_shelf",
         "breaths_per_minute": 12.0, "inhale_ratio": 0.38, "min_val": 0.70, "max_val": 1.15},
        {"motion_id": "CARD_01", "model": "cardiac_pulse", "target_parameter": "sub_ducking_envelope",
         "heart_rate_bpm": 140.0, "dicrotic_notch_strength": 0.40, "min_val": 0.10, "max_val": 1.00},
        {"motion_id": "FLEX_01", "model": "joint_flexion", "target_parameter": "lead_tanh_drive",
         "start_angle_deg": 15.0, "end_angle_deg": 165.0, "tension_factor": 1.4},
        {"motion_id": "GAIT_01", "model": "gait_cycle", "target_parameter": "percussion_panning_spread",
         "cadence_steps_per_min": 128.0, "stance_ratio": 0.62},
    ]:
        vec, target = eng.resolve_anatomic_motion(m, SR)
        print(f"  {m['motion_id']:<8} {m['model']:<14} -> {target:<26} "
              f"{len(vec)} frames, range {vec.min():.3f}..{vec.max():.3f}")
