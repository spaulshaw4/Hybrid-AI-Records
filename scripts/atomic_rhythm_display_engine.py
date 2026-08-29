# D:\MusicDatasets\scripts\atomic_rhythm_display_engine.py
"""
===============================================================================
HYBRID 1.0 - ATOMIC RHYTHMIC BEATS & VISUAL DISPLAY MATRIX
===============================================================================
Quantises rhythm into irreducible atomic frames, builds multi-track trigger
matrices, and renders a step grid in the terminal.

Frame positions use the exact fractional beat rate and round once per trigger.
Deriving F_atom = floor(F_beat / S_div) from an already-rounded F_beat rounds
twice and lets both errors compound: at 110 BPM with 16ths that is 5.8 frames
of drift per bar, which accumulates across an arrangement.

Glyphs default to ASCII. A Windows console under cp1252 raises
UnicodeEncodeError on U+2588 and the rest of the block-element range, which
would crash the display on the platform it targets. Pass --unicode after
running `chcp 65001` if you want the block glyphs.
"""

import os
import sys
import argparse
import json
from dataclasses import dataclass, asdict

import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

SAMPLE_RATE = 44100

ACCENT_FLOOR = 0.85
NOMINAL_FLOOR = 0.50

GLYPHS_ASCII = {"accent": "#", "hit": "+", "ghost": "-", "rest": "."}
GLYPHS_UNICODE = {"accent": "\u2588", "hit": "\u25a0", "ghost": "\u25aa", "rest": "\u00b7"}


@dataclass
class AtomicTrigger:
    step_index: int
    active: bool
    velocity: float
    micro_offset: int      # integer sample displacement from the grid
    frame_offset: int      # absolute frame, micro-offset included
    grid_frame: int        # where the grid says it belongs, before swing


class AtomicRhythmMatrix:
    def __init__(self, bpm: float, total_bars: int = 1, steps_per_beat: int = 4,
                 time_sig: int = 4, sample_rate: int = SAMPLE_RATE):
        self.bpm = float(bpm)
        self.total_bars = int(total_bars)
        self.steps_per_beat = int(steps_per_beat)
        self.time_sig = int(time_sig)
        self.sample_rate = int(sample_rate)

        self.steps_per_bar = self.time_sig * self.steps_per_beat
        self.total_steps = self.steps_per_bar * self.total_bars

        # Exact rates, kept fractional. Every frame is computed from the
        # absolute atom index so no error carries forward.
        self.frames_per_beat_exact = (60.0 / self.bpm) * self.sample_rate
        self.frames_per_atom_exact = self.frames_per_beat_exact / self.steps_per_beat
        self.frames_per_bar_exact = self.frames_per_beat_exact * self.time_sig

        # Nominal integers, for display only
        self.frames_per_beat = int(round(self.frames_per_beat_exact))
        self.frames_per_atom = int(round(self.frames_per_atom_exact))
        self.frames_per_bar = int(round(self.frames_per_bar_exact))

        self.total_frames = int(round(self.total_bars * self.frames_per_bar_exact))

        self.tracks = {}

    def atom_to_frame(self, absolute_step: int) -> int:
        """Absolute atom index to frame, rounded exactly once."""
        return int(round(absolute_step * self.frames_per_atom_exact))

    def add_track(self, name: str, quadrant: str, pattern, velocities=None,
                  swing_percent: float = 0.0, humanize_frames: int = 0, seed: int = 0):
        """
        Build a track's trigger list.

        swing_percent displaces every second atom later, as a fraction of half an
        atom - the standard swing definition. humanize_frames adds a small
        deterministic jitter drawn from a seeded generator, so a given seed
        always reproduces the same feel.
        """
        if not pattern:
            raise ValueError(f"Track '{name}' has an empty pattern.")

        pattern_len = len(pattern)
        swing_frames = int(round((swing_percent / 100.0) * (self.frames_per_atom_exact * 0.5)))

        rng = np.random.default_rng(seed) if humanize_frames else None

        triggers = []
        for step in range(self.total_steps):
            is_active = bool(pattern[step % pattern_len])

            if velocities:
                vel = float(velocities[step % len(velocities)])
            else:
                vel = 1.0 if is_active else 0.0

            grid_frame = self.atom_to_frame(step)

            micro = 0
            if is_active:
                if step % 2 != 0:
                    micro += swing_frames
                if rng is not None:
                    micro += int(rng.integers(-humanize_frames, humanize_frames + 1))

            triggers.append(AtomicTrigger(
                step_index=step,
                active=is_active,
                velocity=vel if is_active else 0.0,
                micro_offset=micro,
                frame_offset=max(0, grid_frame + micro),
                grid_frame=grid_frame
            ))

        self.tracks[f"[{quadrant}] {name}"] = triggers
        return triggers

    def glyph_for(self, trigger, glyphs):
        if not trigger.active:
            return glyphs["rest"]
        if trigger.velocity >= ACCENT_FLOOR:
            return glyphs["accent"]
        if trigger.velocity >= NOMINAL_FLOOR:
            return glyphs["hit"]
        return glyphs["ghost"]

    def display_grid(self, use_unicode: bool = False, label_width: int = 24):
        glyphs = GLYPHS_UNICODE if use_unicode else GLYPHS_ASCII

        # Each atom renders as glyph + space; a blank separates beats and a bar
        # line closes each bar. Widths are computed, not concatenated into a
        # format spec, which is what made the original header unparseable.
        beat_cell = self.steps_per_beat * 2 + 1
        bar_cell = beat_cell * self.time_sig + 1

        bar_header = " " * label_width + "|"
        for b in range(self.total_bars):
            title = f" BAR {b + 1}"
            bar_header += title.ljust(bar_cell - 1) + "|"

        step_header = " " * label_width + "|"
        for _ in range(self.total_bars):
            for _ in range(self.time_sig):
                for s in range(self.steps_per_beat):
                    step_header += f"{(s % 10)} "
                step_header += " "
            step_header = step_header[:-1] + "|"

        width = max(len(bar_header), len(step_header))
        sep = "=" * width

        print()
        print(sep)
        print(f" HYBRID 1.0 ATOMIC RHYTHM MATRIX // {self.bpm} BPM // "
              f"{self.steps_per_bar} atoms/bar // {self.time_sig}/4")
        print(f" Resolution 1/{self.steps_per_beat * self.time_sig}th note"
              f" | {self.frames_per_atom_exact:.3f} frames/atom exact"
              f" | {self.total_frames:,} frames total")
        print(sep)
        print(bar_header)
        print(step_header)
        print("-" * width)

        for name, triggers in self.tracks.items():
            row = name[:label_width].ljust(label_width) + "|"
            for idx, trig in enumerate(triggers):
                row += self.glyph_for(trig, glyphs) + " "
                if (idx + 1) % self.steps_per_beat == 0:
                    row += " "
                if (idx + 1) % self.steps_per_bar == 0:
                    row = row[:-1] + "|"
            print(row)

        print(sep)
        print(f" {glyphs['accent']} accent >={ACCENT_FLOOR}   "
              f"{glyphs['hit']} hit >={NOMINAL_FLOOR}   "
              f"{glyphs['ghost']} ghost <{NOMINAL_FLOOR}   "
              f"{glyphs['rest']} rest")
        print(sep)
        print()

    def drift_report(self):
        """Compare each active trigger's grid frame against exact musical time."""
        print("Grid accuracy against exact musical time")
        print(f"  exact frames/atom : {self.frames_per_atom_exact:.6f}")
        print(f"  naive integer atom: {self.frames_per_atom} "
              f"(loss {self.frames_per_atom - self.frames_per_atom_exact:+.6f} per atom)")
        print()
        print(f"  {'atom':>6}  {'ours':>12}  {'naive':>12}  {'exact':>14}"
              f"  {'our err':>9}  {'naive err':>10}")

        worst_ours = 0.0
        worst_naive = 0.0

        for step in (0, 15, 16, 63, 64, self.total_steps - 1):
            if step >= self.total_steps:
                continue
            exact = step * self.frames_per_atom_exact
            ours = self.atom_to_frame(step)
            naive = step * self.frames_per_atom
            worst_ours = max(worst_ours, abs(ours - exact))
            worst_naive = max(worst_naive, abs(naive - exact))
            print(f"  {step:>6}  {ours:>12,}  {naive:>12,}  {exact:>14.2f}"
                  f"  {ours - exact:>+9.2f}  {naive - exact:>+10.2f}")

        for step in range(self.total_steps):
            exact = step * self.frames_per_atom_exact
            worst_ours = max(worst_ours, abs(self.atom_to_frame(step) - exact))
            worst_naive = max(worst_naive, abs(step * self.frames_per_atom - exact))

        print()
        print(f"  worst over {self.total_steps} atoms:")
        print(f"    ours  {worst_ours:>8.2f} frames ({worst_ours / self.sample_rate * 1000:.4f} ms)")
        print(f"    naive {worst_naive:>8.2f} frames ({worst_naive / self.sample_rate * 1000:.4f} ms)")
        print()

    def to_arrangement(self, slice_map: dict):
        """
        Export active triggers as recipe arrangement entries.

        slice_map keys are track labels, values are slice filenames. Positions
        are emitted as absolute frames so the constructor does not recompute
        them from bar/beat and reintroduce rounding.
        """
        entries = []
        for name, triggers in self.tracks.items():
            slice_file = slice_map.get(name)
            if not slice_file:
                continue
            for trig in triggers:
                if not trig.active:
                    continue
                entries.append({
                    "slice_file": slice_file,
                    "frame_offset": trig.frame_offset,
                    "gain_linear": round(trig.velocity, 4),
                    "pan": 0.0,
                    "source_track": name,
                    "step": trig.step_index
                })
        return sorted(entries, key=lambda e: e["frame_offset"])


def demo(bpm, bars, steps_per_beat, use_unicode, export_path=None):
    matrix = AtomicRhythmMatrix(bpm=bpm, total_bars=bars,
                                steps_per_beat=steps_per_beat, time_sig=4)

    kick_pattern = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0]
    kick_vels = [1.0, 0, 0, 0.7, 0, 0, 0.9, 0, 0, 0.7, 0, 0, 0.85, 0, 0, 0]
    matrix.add_track("Kick_808", "Q1", kick_pattern, kick_vels)

    sub_pattern = [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0]
    matrix.add_track("Sub_Bass", "Q1", sub_pattern, [0.85])

    snare_pattern = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0]
    snare_vels = [0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0, 1.0, 0, 0.45, 0]
    matrix.add_track("Snare_Main", "Q2", snare_pattern, snare_vels)

    hihat_pattern = [1] * 16
    hihat_vels = [0.9, 0.4, 0.7, 0.4] * 4
    matrix.add_track("HiHat_Closed", "Q3", hihat_pattern, hihat_vels,
                     swing_percent=25.0)

    matrix.display_grid(use_unicode=use_unicode)
    matrix.drift_report()

    print("Swing displacement on HiHat (25% of half an atom):")
    hh = matrix.tracks["[Q3] HiHat_Closed"]
    expected = int(round(0.25 * matrix.frames_per_atom_exact * 0.5))
    for t in hh[:4]:
        print(f"  atom {t.step_index}: grid {t.grid_frame:>7,}"
              f"  micro {t.micro_offset:>+5}  final {t.frame_offset:>7,}")
    print(f"  expected swing offset on odd atoms: {expected:+d} frames "
          f"({expected / SAMPLE_RATE * 1000:.2f} ms)")
    print()

    if export_path:
        arrangement = matrix.to_arrangement({
            "[Q1] Kick_808": "kick_808.wav",
            "[Q1] Sub_Bass": "sub_55hz.wav",
            "[Q2] Snare_Main": "snare_main.wav",
            "[Q3] HiHat_Closed": "hihat_closed.wav",
        })
        payload = {
            "track_title": "Atomic Grid Demo",
            "bpm": bpm,
            "time_signature": [4, 4],
            "total_bars": bars,
            "bit_depth": 16,
            "arrangement": arrangement
        }
        with open(export_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"Exported {len(arrangement)} trigger(s) to {export_path}")

    return matrix


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 atomic rhythm matrix")
    parser.add_argument("--bpm", type=float, default=140.0)
    parser.add_argument("--bars", type=int, default=2)
    parser.add_argument("--steps-per-beat", type=int, default=4,
                        help="4 = 16ths, 8 = 32nds, 16 = 64ths")
    parser.add_argument("--unicode", action="store_true",
                        help="Use block glyphs. Requires a UTF-8 console (chcp 65001).")
    parser.add_argument("--export", default=None, help="Write a recipe JSON here")
    args = parser.parse_args()

    demo(args.bpm, args.bars, args.steps_per_beat, args.unicode, args.export)
