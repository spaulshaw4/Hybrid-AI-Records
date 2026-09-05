"""Soft multi-bus send matrix from the stem classifier softmax."""

from __future__ import annotations

import os
import sys

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.engine_stem_classifier import EngineStemClassifier


class SoftBusRouter:
    def __init__(
        self,
        engine: EngineStemClassifier,
        bleed_threshold: float = 0.15,
        solo_threshold: float = 0.75,
    ):
        self.engine = engine
        self.bleed_threshold = bleed_threshold
        self.solo_threshold = solo_threshold
        self.buses = ["acoustic", "voice", "electric", "beats", "bass"]

    def silent_matrix(self):
        return (
            "SILENT",
            {b: 0.0 for b in self.buses},
            {b: -np.inf for b in self.buses},
        )

    def calculate_routing_matrix_from_probs(self, label: str, conf: float):
        """Build send levels from ``engine.last_probs`` (no extra forward pass)."""
        label = (label or "acoustic").lower()
        probs = getattr(self.engine, "last_probs", {})
        if not probs:
            probs = {b: (1.0 if b == label else 0.0) for b in self.buses}

        if conf >= self.solo_threshold:
            bus_gains = {b: (1.0 if b == label else 0.0) for b in self.buses}
            db_gains = {b: (0.0 if b == label else -96.0) for b in self.buses}
            return f"SOLO_{label.upper()}", bus_gains, db_gains

        filtered_probs = {
            b: (p if p >= self.bleed_threshold else 0.0) for b, p in probs.items()
        }
        total_energy = sum(filtered_probs.values())

        if total_energy <= 0:
            bus_gains = {b: (1.0 if b == label else 0.0) for b in self.buses}
        else:
            bus_gains = {
                b: (filtered_probs.get(b, 0.0) / total_energy) for b in self.buses
            }

        db_gains = {}
        for b, gain in bus_gains.items():
            db_gains[b] = 20.0 * np.log10(gain) if gain > 1e-4 else -96.0

        return "BLENDED", bus_gains, db_gains

    def calculate_routing_matrix(self, wav_path: str):
        """
        Returns:
            routing_mode (str): 'SILENT', 'SOLO_*', or 'BLENDED'
            bus_gains (dict): Linear gain multipliers [0.0 to 1.0] for each bus send
            db_gains (dict): Decibel attenuation [-inf to 0.0 dB] for mixer automation
        """
        label, conf, is_silent = self.engine.predict_wav(wav_path)
        if is_silent:
            return self.silent_matrix()
        return self.calculate_routing_matrix_from_probs(label, conf)


if __name__ == "__main__":
    engine = EngineStemClassifier("models/checkpoints/stem_classifier_latest.pt")
    router = SoftBusRouter(engine, bleed_threshold=0.15, solo_threshold=0.75)

    clinic = r"C:\staging_slices\001 - ANiMAL - Clinic A"
    tests = [
        os.path.join(clinic, "bass_s4_00000_bass_locked.wav"),
        os.path.join(clinic, "bass_s4_00002_bass_locked.wav"),
        os.path.join(clinic, "vocals_s4_00011_voice_locked.wav"),
    ]
    for test_wav in tests:
        if not os.path.isfile(test_wav):
            print(f"missing {test_wav}")
            continue
        mode, linear_sends, db_sends = router.calculate_routing_matrix(test_wav)
        print(f"\n{os.path.basename(test_wav)}")
        print(f"Routing Mode: {mode}")
        print("Linear Gains:", {k: round(v, 3) for k, v in linear_sends.items()})
        print(
            "Decibel Sends (dB):",
            {
                k: (f"{v:.1f} dB" if v > -96 else "-inf")
                for k, v in db_sends.items()
            },
        )
