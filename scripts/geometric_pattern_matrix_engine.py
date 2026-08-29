# D:\MusicDatasets\scripts\geometric_pattern_matrix_engine.py
"""
===============================================================================
HYBRID 1.0 - GEOMETRIC PATTERN & AFFINE MATRIX ENGINE
===============================================================================
  1. Regular N-gon projection: vertices on the unit circle mapped to frames,
     with pan from cos(theta) and velocity from (1 + sin(theta)) / 2.
  2. 2D affine transform: rotation, scale and translation of (pan, velocity)
     pairs through a 3x3 homogeneous matrix.
  3. Sierpinski sieve: binomial(i, j) mod 2 via Kummer's theorem, (i & j) == j.
  4. ASCII terminal display.

Two departures from a literal implementation:

  * The cycle a polygon spans is explicit. Mapping vertices across the whole
    canvas means a triangle over 8 bars fires three times in eight bars, which
    is a structural accent rather than a rhythm. --cycle-bars sets how many bars
    one revolution covers, so the same polygon can be a per-bar groove or a
    long-form arc.

  * Frames come from the exact fractional bar length, rounded once per vertex.
    Deriving a step size from an already-rounded frames-per-beat rounds twice
    and drifts at any tempo where 60/BPM*fs is fractional.

Glyphs are ASCII by default: a cp1252 console raises UnicodeEncodeError on the
U+25xx arrow and block ranges.
"""

import os
import sys
import argparse
from dataclasses import dataclass

import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

SAMPLE_RATE = 44100

PAN_LEFT_THRESHOLD = -0.35
PAN_RIGHT_THRESHOLD = 0.35

GLYPHS_ASCII = {"left": "<", "right": ">", "center": "o", "rest": ".", "on": "#"}
GLYPHS_UNICODE = {"left": "\u25c4", "right": "\u25ba", "center": "\u25c6",
                  "rest": "\u00b7", "on": "\u2588"}


@dataclass
class GeometricVertex:
    index: int
    angle_rad: float
    frame_offset: int
    pan: float
    velocity: float


class GeometricMatrixEngine:
    def __init__(self, bpm: float, total_bars: int = 2, steps_per_bar: int = 16,
                 time_sig: int = 4, sample_rate: int = SAMPLE_RATE):
        self.bpm = float(bpm)
        self.total_bars = int(total_bars)
        self.steps_per_bar = int(steps_per_bar)
        self.time_sig = int(time_sig)
        self.sample_rate = int(sample_rate)

        self.frames_per_beat_exact = (60.0 / self.bpm) * self.sample_rate
        self.frames_per_bar_exact = self.frames_per_beat_exact * self.time_sig
        self.frames_per_step_exact = self.frames_per_bar_exact / self.steps_per_bar

        self.total_frames = int(round(self.total_bars * self.frames_per_bar_exact))
        self.total_steps = self.steps_per_bar * self.total_bars

    # ------------------------------------------------------------------
    # 1. N-gon projection
    # ------------------------------------------------------------------

    def generate_polygon_vertices(self, n_sides: int, phase_offset_deg: float = 0.0,
                                  radius_scale: float = 1.0,
                                  cycle_bars: float = None,
                                  repeat: bool = True):
        """
        Project an n-gon's vertices onto the timeline.

        cycle_bars is how many bars one full revolution spans; it defaults to the
        whole canvas. With repeat, the figure recurs for every cycle that fits,
        which turns a polygon into a rhythm rather than a one-off gesture.
        """
        if n_sides < 2:
            raise ValueError("A polygon needs at least 2 vertices.")

        cycle_bars = float(cycle_bars) if cycle_bars else float(self.total_bars)
        cycle_frames = cycle_bars * self.frames_per_bar_exact
        phase_rad = np.radians(phase_offset_deg)

        cycles = int(self.total_bars / cycle_bars) if repeat else 1
        cycles = max(1, cycles)

        vertices = []
        idx = 0
        for c in range(cycles):
            cycle_start = c * cycle_frames
            for k in range(n_sides):
                angle = (2.0 * np.pi * k / n_sides) + phase_rad
                norm = angle % (2.0 * np.pi)

                frame = int(round(cycle_start + (norm / (2.0 * np.pi)) * cycle_frames))
                if frame >= self.total_frames:
                    continue

                vertices.append(GeometricVertex(
                    index=idx,
                    angle_rad=norm,
                    frame_offset=frame,
                    pan=float(np.clip(np.cos(angle) * radius_scale, -1.0, 1.0)),
                    velocity=float(np.clip((1.0 + np.sin(angle)) * 0.5 * radius_scale, 0.2, 1.0))
                ))
                idx += 1

        return sorted(vertices, key=lambda v: v.frame_offset)

    # ------------------------------------------------------------------
    # 2. Affine transform
    # ------------------------------------------------------------------

    @staticmethod
    def apply_affine_transform(points: np.ndarray, rotation_deg: float = 0.0,
                               scale_x: float = 1.0, scale_y: float = 1.0,
                               trans_x: float = 0.0, trans_y: float = 0.0) -> np.ndarray:
        """
        Transform (pan, velocity) pairs through a 3x3 homogeneous matrix.

        Note this rotates one axis into the other, so pan bleeds into velocity
        and back. That is musically arbitrary but deliberate - it is what makes
        a rotation read as a coupled spatial-dynamic sweep rather than two
        independent curves.
        """
        pts = np.asarray(points, dtype=np.float64)
        if pts.ndim != 2 or pts.shape[1] != 2:
            raise ValueError(f"Expected (N, 2) points, got {pts.shape}")

        rad = np.radians(rotation_deg)
        c, s = np.cos(rad), np.sin(rad)

        matrix = np.array([
            [scale_x * c, -scale_y * s, trans_x],
            [scale_x * s,  scale_y * c, trans_y],
            [0.0,          0.0,         1.0]
        ], dtype=np.float64)

        homog = np.column_stack((pts, np.ones(len(pts))))
        return (homog @ matrix.T)[:, :2]

    # ------------------------------------------------------------------
    # 3. Sierpinski sieve
    # ------------------------------------------------------------------

    @staticmethod
    def generate_sierpinski_matrix(size: int = 16) -> np.ndarray:
        """
        binomial(i, j) mod 2 == 1 exactly when (i & j) == j.

        Kummer's theorem: the binomial is odd iff subtracting j from i in binary
        requires no borrow, which is the same as j's set bits being a subset of
        i's. Avoids computing large binomials entirely.
        """
        i = np.arange(size).reshape(-1, 1)
        j = np.arange(size).reshape(1, -1)
        return (((i & j) == j) & (j <= i)).astype(np.int32)

    def sierpinski_to_tracks(self, size: int = 16, n_tracks: int = 8):
        """Take the first n_tracks rows as step patterns, tiled to the grid."""
        matrix = self.generate_sierpinski_matrix(size)
        tracks = {}
        for row in range(min(n_tracks, size)):
            pattern = matrix[row].tolist()
            tiled = [pattern[s % len(pattern)] for s in range(self.total_steps)]
            tracks[f"Sierpinski row {row:>2}"] = tiled
        return tracks

    # ------------------------------------------------------------------
    # 4. Display
    # ------------------------------------------------------------------

    def display_geometric_grid(self, track_layers: dict, use_unicode: bool = False,
                               label_width: int = 24):
        glyphs = GLYPHS_UNICODE if use_unicode else GLYPHS_ASCII

        bar_cell = self.steps_per_bar * 2 + 1

        header = "GEOMETRIC SHAPE".ljust(label_width) + "|"
        for b in range(self.total_bars):
            header += f" BAR {b + 1}".ljust(bar_cell - 1) + "|"

        sep = "=" * len(header)

        print()
        print(sep)
        print(f" HYBRID 1.0 GEOMETRIC PATTERN MATRIX // {self.bpm} BPM // "
              f"{self.total_bars} bars // {self.steps_per_bar} steps/bar")
        print(f" {self.frames_per_step_exact:.3f} frames/step exact | "
              f"{self.total_frames:,} frames total")
        print(sep)
        print(header)
        print("-" * len(header))

        for name, vertices in track_layers.items():
            grid = [glyphs["rest"]] * self.total_steps

            for v in vertices:
                step = int(round(v.frame_offset / self.frames_per_step_exact))
                if not 0 <= step < self.total_steps:
                    continue
                if v.pan < PAN_LEFT_THRESHOLD:
                    grid[step] = glyphs["left"]
                elif v.pan > PAN_RIGHT_THRESHOLD:
                    grid[step] = glyphs["right"]
                else:
                    grid[step] = glyphs["center"]

            row = name[:label_width].ljust(label_width) + "|"
            for s in range(self.total_steps):
                row += grid[s] + " "
                if (s + 1) % self.steps_per_bar == 0:
                    row = row[:-1] + "|"
            print(row)

        print(sep)
        print(f" {glyphs['left']} pan < {PAN_LEFT_THRESHOLD}   "
              f"{glyphs['right']} pan > {PAN_RIGHT_THRESHOLD}   "
              f"{glyphs['center']} centre   {glyphs['rest']} rest")
        print(sep)
        print()

    def display_binary_tracks(self, tracks: dict, use_unicode: bool = False,
                              label_width: int = 24):
        glyphs = GLYPHS_UNICODE if use_unicode else GLYPHS_ASCII

        for name, pattern in tracks.items():
            row = name[:label_width].ljust(label_width) + "|"
            for s, bit in enumerate(pattern):
                row += (glyphs["on"] if bit else glyphs["rest"]) + " "
                if (s + 1) % self.steps_per_bar == 0:
                    row = row[:-1] + "|"
            print(row)


def main():
    parser = argparse.ArgumentParser(description="Hybrid 1.0 geometric pattern matrix")
    parser.add_argument("--bpm", type=float, default=140.0)
    parser.add_argument("--bars", type=int, default=2)
    parser.add_argument("--steps-per-bar", type=int, default=16)
    parser.add_argument("--cycle-bars", type=float, default=1.0,
                        help="Bars per polygon revolution. Default 1 makes each polygon a groove.")
    parser.add_argument("--unicode", action="store_true")
    args = parser.parse_args()

    geo = GeometricMatrixEngine(bpm=args.bpm, total_bars=args.bars,
                                steps_per_bar=args.steps_per_bar)

    layers = {}
    for sides, phase, label, quad in ((3, 0.0, "Triangle (3-gon)", "Q1"),
                                      (4, 45.0, "Square (4-gon)", "Q1"),
                                      (5, 90.0, "Pentagon (5-gon)", "Q2"),
                                      (6, 0.0, "Hexagon (6-gon)", "Q3")):
        layers[f"[{quad}] {label}"] = geo.generate_polygon_vertices(
            n_sides=sides, phase_offset_deg=phase, cycle_bars=args.cycle_bars)

    geo.display_geometric_grid(layers, use_unicode=args.unicode)

    print("Vertex detail, hexagon, first revolution:")
    print(f"  {'k':>3}  {'angle':>8}  {'frame':>10}  {'pan':>7}  {'velocity':>9}")
    for v in layers["[Q3] Hexagon (6-gon)"][:6]:
        print(f"  {v.index:>3}  {np.degrees(v.angle_rad):>7.1f}d  {v.frame_offset:>10,}"
              f"  {v.pan:>+7.3f}  {v.velocity:>9.3f}")

    print()
    print("Frame accuracy: vertices against exact musical time")
    cycle_frames = args.cycle_bars * geo.frames_per_bar_exact
    worst = 0.0
    for v in layers["[Q3] Hexagon (6-gon)"][:6]:
        exact = (v.angle_rad / (2.0 * np.pi)) * cycle_frames
        worst = max(worst, abs(v.frame_offset - exact))
    print(f"  worst vertex error: {worst:.3f} frames "
          f"({worst / SAMPLE_RATE * 1000:.5f} ms)")

    print()
    print("2D affine transform on hexagon vertices (rotate 45d, scale 1.2 / 0.9):")
    raw = np.array([[v.pan, v.velocity] for v in layers["[Q3] Hexagon (6-gon)"][:6]])
    out = geo.apply_affine_transform(raw, rotation_deg=45.0, scale_x=1.2, scale_y=0.9)
    print(f"  {'k':>3}  {'pan in':>8}{'vel in':>9}   ->  {'pan out':>9}{'vel out':>9}")
    for i, (a, b) in enumerate(zip(raw, out)):
        print(f"  {i:>3}  {a[0]:>+8.3f}{a[1]:>9.3f}   ->  {b[0]:>+9.3f}{b[1]:>9.3f}")

    identity = geo.apply_affine_transform(raw, rotation_deg=0.0, scale_x=1.0, scale_y=1.0)
    print(f"  identity transform round-trips: {np.allclose(identity, raw)}")

    print()
    print("Sierpinski sieve, 16x16, via (i & j) == j:")
    sieve = geo.generate_sierpinski_matrix(16)
    on = GLYPHS_UNICODE["on"] if args.unicode else GLYPHS_ASCII["on"]
    rest = GLYPHS_UNICODE["rest"] if args.unicode else GLYPHS_ASCII["rest"]
    for row in sieve:
        print("  " + " ".join(on if v else rest for v in row))

    print()
    print("  row pulse counts (powers of 2, as Kummer predicts):")
    print("   ", [int(r.sum()) for r in sieve])

    print()
    print("Sierpinski rows as step patterns:")
    geo.display_binary_tracks(geo.sierpinski_to_tracks(size=args.steps_per_bar, n_tracks=6),
                              use_unicode=args.unicode)
    print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
