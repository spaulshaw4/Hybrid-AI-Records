# D:\MusicDatasets\scripts\motion_automation_engine.py
"""
===============================================================================
HYBRID 1.0 - SAMPLE-ACCURATE MOTION AUTOMATION ENGINE
===============================================================================
Frame-locked modulation vectors for gain, pan, stereo width, and saturation
drive. Envelopes are computed per sample rather than at a control rate, so there
is no stepping or zipper noise and no drift against the integer frame grid.

Curves, with tau = (n - F_start) / (F_end - F_start) in [0, 1]:

  linear        v0 + (v1 - v0) * tau
  exponential   v0 * (v1/v0)^tau            perceptually even frequency sweeps
  s_curve       cosine-eased tau            organic section transitions
  logarithmic   log1p(9*tau)/log1p(9)       fast attack, slow settle
  lfo_sine      center + A*sin(2*pi*f*n/fs) continuous rotation, tremolo

Two deliberate departures from a naive implementation:

  * LFO output is not clamped to [-1, 1]. That range is correct for pan but
    would destroy any other target - a filter cutoff oscillating around 2000 Hz
    would be flattened to 1.0. Clamping is the caller's job, applied per
    parameter by apply_pan_motion and friends.

  * A modulation vector shorter than the audio holds its final value rather
    than truncating the buffer. Truncating silently shortens the slice, which
    on a timeline canvas shows up as an unexplained gap.
"""

import os
import sys
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

DEFAULT_SAMPLE_RATE = 44100

CURVE_TYPES = ("linear", "exponential", "s_curve", "logarithmic")


def fit_vector(vector: np.ndarray, length: int) -> np.ndarray:
    """Hold the last value if short, trim if long. Never resizes the audio."""
    if len(vector) == length:
        return vector
    if len(vector) > length:
        return vector[:length]
    if len(vector) == 0:
        return np.ones(length, dtype=np.float32)
    return np.pad(vector, (0, length - len(vector)), mode="edge")


class MotionAutomationEngine:
    def __init__(self, sample_rate: int = DEFAULT_SAMPLE_RATE):
        self.sample_rate = sample_rate

    def generate_curve(self, length_samples: int, start_val: float,
                       end_val: float, curve_type: str = "linear") -> np.ndarray:
        if length_samples <= 0:
            return np.array([], dtype=np.float32)

        tau = np.linspace(0.0, 1.0, length_samples, endpoint=True, dtype=np.float32)

        if curve_type == "linear":
            return start_val + (end_val - start_val) * tau

        if curve_type == "exponential":
            # A ratio sweep cannot pass through or start at zero, so both ends
            # are floored. Without this, v1/v0 is a division by zero.
            start_safe = max(1e-5, float(start_val))
            end_safe = max(1e-5, float(end_val))
            return (start_safe * ((end_safe / start_safe) ** tau)).astype(np.float32)

        if curve_type == "s_curve":
            s_tau = (1.0 - np.cos(np.pi * tau)) * 0.5
            return start_val + (end_val - start_val) * s_tau

        if curve_type == "logarithmic":
            log_tau = np.log1p(9.0 * tau) / np.log1p(9.0)
            return start_val + (end_val - start_val) * log_tau

        return np.full(length_samples, start_val, dtype=np.float32)

    def generate_lfo(self, length_samples: int, rate_hz: float, depth: float,
                     center: float = 0.0, phase_offset: float = 0.0,
                     clamp=None) -> np.ndarray:
        """
        Periodic modulation. Returns center +/- depth, unclamped by default.

        Pass clamp=(lo, hi) when the target has hard bounds; leaving it None is
        correct for cutoffs, drive, and anything else not confined to [-1, 1].
        """
        if length_samples <= 0:
            return np.array([], dtype=np.float32)

        n = np.arange(length_samples, dtype=np.float32)
        lfo = np.sin(2.0 * np.pi * rate_hz * n / self.sample_rate + phase_offset) * depth
        out = (center + lfo).astype(np.float32)

        if clamp is not None:
            out = np.clip(out, clamp[0], clamp[1])
        return out

    def apply_gain_motion(self, stereo_audio: np.ndarray, gain_vector: np.ndarray) -> np.ndarray:
        gain = fit_vector(np.asarray(gain_vector, dtype=np.float32), len(stereo_audio))
        return stereo_audio * gain[:, None]

    def apply_pan_motion(self, stereo_audio: np.ndarray, pan_vector: np.ndarray) -> np.ndarray:
        """Continuous constant-power pan. pan_vector is clamped here, where the
        [-1, 1] range genuinely applies."""
        pan = fit_vector(np.asarray(pan_vector, dtype=np.float32), len(stereo_audio))
        pan = np.clip(pan, -1.0, 1.0)

        pan_rad = (pan + 1.0) * (np.pi / 4.0)

        out = np.empty_like(stereo_audio)
        out[:, 0] = stereo_audio[:, 0] * np.cos(pan_rad)
        out[:, 1] = stereo_audio[:, 1] * np.sin(pan_rad)
        return out

    def apply_stereo_width_motion(self, stereo_audio: np.ndarray, width_vector: np.ndarray) -> np.ndarray:
        """Dynamic mid/side width. width 1.0 round-trips to the input exactly."""
        w = fit_vector(np.asarray(width_vector, dtype=np.float32), len(stereo_audio))
        w = np.clip(w, 0.0, 2.0)

        mid = 0.5 * (stereo_audio[:, 0] + stereo_audio[:, 1])
        side = 0.5 * (stereo_audio[:, 0] - stereo_audio[:, 1]) * w

        return np.column_stack((mid + side, mid - side))

    def apply_drive_motion(self, stereo_audio: np.ndarray, drive_vector: np.ndarray) -> np.ndarray:
        """Time-varying tanh saturation, matching the Q2 harmonic drive law."""
        d = fit_vector(np.asarray(drive_vector, dtype=np.float32), len(stereo_audio))
        d = np.maximum(d, 0.0)[:, None]
        return np.tanh(stereo_audio * (1.0 + d * 0.1))

    # -----------------------------------------------------------------
    # Recipe-driven resolution
    # -----------------------------------------------------------------

    def resolve_motion(self, motion: dict, samples_per_bar: int, samples_per_beat: int):
        """
        Turn one recipe motion block into (start_frame, vector, parameter).

        Frames come from the same integer grid the constructor uses, so a motion
        and the slice it targets cannot drift apart.
        """
        def to_frame(bar, beat):
            return int((int(bar) - 1) * samples_per_bar +
                       round((float(beat) - 1.0) * samples_per_beat))

        start_frame = to_frame(motion.get("start_bar", 1), motion.get("start_beat", 1.0))
        end_frame = to_frame(motion.get("end_bar", 1), motion.get("end_beat", 1.0))
        length = max(0, end_frame - start_frame)

        if length == 0:
            return start_frame, np.array([], dtype=np.float32), motion.get("parameter")

        curve = motion.get("curve", "linear")
        parameter = motion.get("parameter", "gain_linear")

        if curve == "lfo_sine" or parameter.endswith("_lfo"):
            # Pan LFOs oscillate about centre; other targets about their value.
            center = float(motion.get("center", 0.0))
            vector = self.generate_lfo(
                length,
                rate_hz=float(motion.get("rate_hz", 0.5)),
                depth=float(motion.get("depth", 0.5)),
                center=center,
                phase_offset=float(motion.get("phase_offset", 0.0)),
                clamp=(-1.0, 1.0) if "pan" in parameter else None
            )
        else:
            vector = self.generate_curve(
                length,
                float(motion.get("start_val", 1.0)),
                float(motion.get("end_val", 1.0)),
                curve
            )

        return start_frame, vector, parameter

    def apply_recipe_motions(self, audio: np.ndarray, slice_start_frame: int,
                             motions: list, samples_per_bar: int, samples_per_beat: int,
                             stem_name: str = None):
        """
        Apply every motion targeting this stem, positioned relative to where the
        slice sits on the timeline.

        A motion covering bars 1-5 while its slice starts at bar 3 must apply
        only its overlapping portion, not restart from tau=0.
        """
        applied = []

        for motion in motions or []:
            target = motion.get("target_stem")
            if stem_name and target and target != stem_name:
                continue

            m_start, vector, parameter = self.resolve_motion(
                motion, samples_per_bar, samples_per_beat)

            if len(vector) == 0:
                continue

            # Overlap between the motion's frame span and this slice's span
            offset = m_start - slice_start_frame
            if offset >= len(audio) or offset + len(vector) <= 0:
                continue

            seg_vec = vector[max(0, -offset):]
            seg_start = max(0, offset)
            seg_len = min(len(seg_vec), len(audio) - seg_start)

            if seg_len <= 0:
                continue

            segment = audio[seg_start:seg_start + seg_len]
            sub_vec = seg_vec[:seg_len]

            if parameter in ("gain_linear", "gain"):
                audio[seg_start:seg_start + seg_len] = self.apply_gain_motion(segment, sub_vec)
            elif parameter in ("pan", "pan_lfo"):
                audio[seg_start:seg_start + seg_len] = self.apply_pan_motion(segment, sub_vec)
            elif parameter in ("stereo_width", "mid_side_width"):
                audio[seg_start:seg_start + seg_len] = self.apply_stereo_width_motion(segment, sub_vec)
            elif parameter in ("drive", "saturation_drive"):
                audio[seg_start:seg_start + seg_len] = self.apply_drive_motion(segment, sub_vec)
            else:
                continue

            applied.append({
                "motion_id": motion.get("motion_id", "unnamed"),
                "parameter": parameter,
                "curve": motion.get("curve", "linear"),
                "frames": seg_len
            })

        return audio, applied


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Hybrid 1.0 motion automation engine")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if not args.self_test:
        print("This module is a library. Run with --self-test to verify behaviour.")
        sys.exit(0)

    eng = MotionAutomationEngine()
    N = 1000

    print("=== curve endpoints and shape (0.05 -> 0.85 over 1000 frames) ===")
    for ct in CURVE_TYPES:
        v = eng.generate_curve(N, 0.05, 0.85, ct)
        mid = v[N // 2]
        monotonic = bool(np.all(np.diff(v) >= -1e-6))
        print(f"  {ct:<12} start {v[0]:.4f}  mid {mid:.4f}  end {v[-1]:.4f}  "
              f"monotonic {monotonic}")

    print("\n  s_curve midpoint should sit at the linear midpoint (0.4500):")
    print(f"    s_curve mid = {eng.generate_curve(N, 0.05, 0.85, 's_curve')[N//2]:.4f}")
    print("  exponential midpoint should sit below it (geometric mean 0.2062):")
    print(f"    exponential mid = {eng.generate_curve(N, 0.05, 0.85, 'exponential')[N//2]:.4f}")

    print("\n=== LFO is not clamped for non-pan targets ===")
    # A 0.5 Hz cycle is 2 seconds, so the window must span at least that or the
    # sine barely moves and the range looks wrong.
    LFO_N = int(DEFAULT_SAMPLE_RATE * 2.0)
    cutoff = eng.generate_lfo(LFO_N, rate_hz=0.5, depth=800.0, center=2000.0)
    print(f"  cutoff LFO 2000 Hz +/-800 over {LFO_N/DEFAULT_SAMPLE_RATE:.1f}s: "
          f"min {cutoff.min():.1f}  max {cutoff.max():.1f} Hz")
    print(f"  -> {'range preserved' if cutoff.max() > 1.5 else 'WRONGLY CLAMPED'}")

    panned = eng.generate_lfo(LFO_N, rate_hz=0.5, depth=2.0, center=0.0, clamp=(-1.0, 1.0))
    print(f"  pan LFO depth 2.0 clamped to [-1,1]: min {panned.min():.2f}  max {panned.max():.2f}")
    print(f"  -> {'clamped correctly' if panned.min() >= -1.0 and panned.max() <= 1.0 else 'ESCAPED'}")

    print("\n=== short vector holds instead of truncating ===")
    audio = np.ones((N, 2), dtype=np.float32)
    short = np.linspace(1.0, 0.0, 100).astype(np.float32)
    out = eng.apply_gain_motion(audio, short)
    print(f"  audio {len(audio)} frames, vector {len(short)} -> output {len(out)} frames")
    print(f"  length preserved : {len(out) == len(audio)}")
    print(f"  tail holds final value {short[-1]:.2f}: {np.allclose(out[-1], 0.0)}")

    print("\n=== width 1.0 round-trips exactly ===")
    rng = np.random.default_rng(3)
    sig = rng.standard_normal((N, 2)).astype(np.float32)
    rt = eng.apply_stereo_width_motion(sig, np.ones(N, dtype=np.float32))
    print(f"  max deviation: {np.max(np.abs(rt - sig)):.3e}")
    print(f"  -> {'exact' if np.allclose(rt, sig, atol=1e-6) else 'LOSSY'}")

    print("\n=== pan motion holds constant power ===")
    mono = np.ones((5, 2), dtype=np.float32)
    for p in (-1.0, -0.5, 0.0, 0.5, 1.0):
        o = eng.apply_pan_motion(mono, np.full(5, p, dtype=np.float32))
        power = o[0, 0] ** 2 + o[0, 1] ** 2
        print(f"  pan {p:+.1f} -> L {o[0,0]:.4f} R {o[0,1]:.4f}  power {power:.4f}")

    print("\n=== recipe motion resolution on the integer grid (140 BPM 4/4) ===")
    spb = int(round((60.0 / 140.0) * 44100))
    spbar = spb * 4
    motion = {"motion_id": "MOT_01", "parameter": "gain_linear", "start_bar": 1,
              "start_beat": 1.0, "end_bar": 5, "end_beat": 1.0, "curve": "exponential",
              "start_val": 0.05, "end_val": 0.85}
    sf, vec, param = eng.resolve_motion(motion, spbar, spb)
    print(f"  bars 1-5 -> start frame {sf}, {len(vec)} frames "
          f"({len(vec)/44100:.3f}s), parameter {param}")
    print(f"  expected 4 bars = {4*spbar} frames: {len(vec) == 4*spbar}")
