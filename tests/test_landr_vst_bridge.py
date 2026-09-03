from __future__ import annotations

import numpy as np

from dsp.landr_vst_bridge import apply_landr_bus_with_fallback


def test_bridge_fallback_shape_and_dtype():
    audio = np.zeros((2, 4096), dtype=np.float32)
    audio[:, 0] = 0.5
    out = apply_landr_bus_with_fallback(
        audio,
        sr=44100,
        bus_type="acoustic",
        intensity=0.6,
        prefer_vst=False,
    )
    assert out.shape == audio.shape
    assert out.dtype == np.float32


def test_bridge_rejects_unknown_bus():
    audio = np.zeros((2, 1024), dtype=np.float32)
    try:
        apply_landr_bus_with_fallback(audio, 44100, "unknown", prefer_vst=False)
    except ValueError as exc:
        assert "Unsupported LANDR bus type" in str(exc)
    else:
        raise AssertionError("Expected ValueError for unknown LANDR bus")
