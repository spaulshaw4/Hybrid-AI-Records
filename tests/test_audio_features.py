"""Audio features are spectral, deterministic, and filename-blind."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from ml.audio_features import (  # noqa: E402
    N_FEATURES,
    TARGET_SR,
    extract_features,
    extract_from_file,
    feature_names,
)


def _bass_tone(sr: int = TARGET_SR, seconds: float = 1.0) -> np.ndarray:
    t = np.linspace(0.0, seconds, int(sr * seconds), endpoint=False)
    return 0.7 * np.sin(2 * np.pi * 55.0 * t) + 0.25 * np.sin(2 * np.pi * 110.0 * t)


def _drum_clicks(sr: int = TARGET_SR, seconds: float = 1.0, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(sr * seconds)
    x = np.zeros(n, dtype=np.float64)
    hop = sr // 8
    click = max(8, int(0.012 * sr))
    for start in range(0, n, hop):
        end = min(n, start + click)
        burst = rng.normal(0.0, 1.0, end - start) * np.hanning(end - start)
        x[start:end] += burst
    peak = np.max(np.abs(x)) + 1e-9
    return x / peak


def _vocalish(sr: int = TARGET_SR, seconds: float = 1.0) -> np.ndarray:
    t = np.linspace(0.0, seconds, int(sr * seconds), endpoint=False)
    x = np.zeros_like(t)
    f0 = 220.0
    for k in range(1, 10):
        x += (0.35 / k) * np.sin(2 * np.pi * f0 * k * t)
    x *= 0.7 + 0.3 * np.sin(2 * np.pi * 5.0 * t)
    return x


class TestAudioFeatures(unittest.TestCase):
    def test_vector_length_matches_names(self):
        names = feature_names()
        self.assertEqual(len(names), N_FEATURES)
        self.assertEqual(len(set(names)), N_FEATURES)
        vec = extract_features(_bass_tone(), TARGET_SR)
        self.assertEqual(vec.shape, (N_FEATURES,))
        self.assertEqual(vec.dtype, np.float32)

    def test_deterministic(self):
        buf = _drum_clicks()
        a = extract_features(buf, TARGET_SR)
        b = extract_features(buf, TARGET_SR)
        np.testing.assert_array_equal(a, b)

    def test_bass_has_more_low_energy_than_drums(self):
        names = feature_names()
        low_high = names.index("low_high_ratio")
        bass = extract_features(_bass_tone(), TARGET_SR)
        drums = extract_features(_drum_clicks(), TARGET_SR)
        self.assertGreater(float(bass[low_high]), float(drums[low_high]))

    def test_filename_is_not_a_feature(self):
        """Same buffer under a misleading name still yields the same vector."""
        buf = _bass_tone()
        with tempfile.TemporaryDirectory() as tmp:
            bass_name = os.path.join(tmp, "bass_s4_00000.wav")
            fake_vox = os.path.join(tmp, "vocals_s4_00000.wav")
            stereo = np.stack([buf, buf], axis=1)
            sf.write(bass_name, stereo, TARGET_SR)
            sf.write(fake_vox, stereo, TARGET_SR)
            va = extract_from_file(bass_name)
            vb = extract_from_file(fake_vox)
            self.assertIsNotNone(va)
            self.assertIsNotNone(vb)
            np.testing.assert_allclose(va, vb, rtol=1e-5, atol=1e-5)

    def test_roles_are_spectrally_distinct(self):
        """Synthetic roles should not collapse to one vector (guards a no-op extractor)."""
        vecs = {
            "bass": extract_features(_bass_tone(), TARGET_SR),
            "drums": extract_features(_drum_clicks(), TARGET_SR),
            "vocals": extract_features(_vocalish(), TARGET_SR),
        }
        for a, b in (("bass", "drums"), ("bass", "vocals"), ("drums", "vocals")):
            dist = float(np.linalg.norm(vecs[a] - vecs[b]))
            self.assertGreater(dist, 0.5, msg=f"{a} vs {b} too similar ({dist})")


if __name__ == "__main__":
    unittest.main()
