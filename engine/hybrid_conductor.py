"""Adaptive Frame Conductor — commercial hit topography without verse/chorus boxes.

One cohesive band (drums / bass / rhythm) is locked from the corpus. A
continuous tension map (1–100) then drives DSP so the same stems rise, drop,
filter, and widen like a human arrangement.
"""
from __future__ import annotations

from typing import Any

import numpy as np


def _ramp(start: float, end: float, count: int) -> np.ndarray:
    n = int(count)
    if n <= 0:
        return np.zeros(0, dtype=np.float64)
    if n == 1:
        return np.asarray([end], dtype=np.float64)
    return np.linspace(float(start), float(end), n, dtype=np.float64)


class AdaptiveConductor:
    """Tension topography + mixing-console commands for any track length."""

    def __init__(self, total_bars: int, genre: str | None = None) -> None:
        self.total_bars = max(1, int(total_bars))
        self.genre = str(genre or "hybrid")

    def generate_tension_map(self) -> np.ndarray:
        """Commercial hit frame as tension (1–100), not rigid section names.

        Intro 10% → build 20% → first peak 20% → drop 15% → climax 25% → outro 10%.
        """
        n = self.total_bars
        tension = np.zeros(n, dtype=np.float64)

        intro_end = int(n * 0.10)
        build_end = intro_end + int(n * 0.20)
        peak_end = build_end + int(n * 0.20)
        drop_end = peak_end + int(n * 0.15)
        climax_end = drop_end + int(n * 0.25)

        tension[0:intro_end] = _ramp(10, 25, intro_end)
        tension[intro_end:build_end] = _ramp(25, 75, build_end - intro_end)
        tension[build_end:peak_end] = _ramp(75, 90, peak_end - build_end)
        tension[peak_end:drop_end] = _ramp(40, 20, drop_end - peak_end)
        tension[drop_end:climax_end] = _ramp(85, 100, climax_end - drop_end)
        tension[climax_end:] = _ramp(80, 5, n - climax_end)

        return np.clip(tension, 1.0, 100.0)

    def evaluate_dsp_rules(self, current_tension: float) -> dict[str, Any]:
        """Translate one bar of tension into mixing-console commands."""
        level = float(current_tension)
        commands: dict[str, Any] = {
            "drums_active": True,
            "kick_muted": False,
            "bass_active": True,
            "rhythm_filter": None,
            "stereo_width": 1.0,
            "lead_active": level >= 75.0,
            "rhythm_swell": level >= 85.0,
            "tension": level,
        }

        if level < 25:
            commands["drums_active"] = False
            commands["bass_active"] = False
            commands["rhythm_filter"] = "lowpass_600Hz"
            commands["stereo_width"] = 0.5
            commands["lead_active"] = False
        elif level < 50:
            commands["kick_muted"] = True
            commands["bass_active"] = False
            commands["rhythm_filter"] = "lowpass_2000Hz"
            commands["lead_active"] = False
        elif level < 75:
            commands["rhythm_filter"] = None
            commands["stereo_width"] = 0.8
        elif level >= 85:
            commands["stereo_width"] = 1.25

        return commands

    def tension_to_unit(self, tension: float) -> float:
        return float(np.clip(float(tension) / 100.0, 0.0, 1.0))
