from __future__ import annotations

import numpy as np

from dsp.native_audio_engine import NativeAudioEngine


def test_process_bus_keeps_shape_and_dtype_stereo():
    engine = NativeAudioEngine(sample_rate=44100)
    audio = np.zeros((2, 44100), dtype=np.float32)
    audio[:, 0] = 0.25
    out = engine.process_bus(audio, "acoustic", intensity=0.7)
    assert out.shape == audio.shape
    assert out.dtype == np.float32


def test_process_bus_mono_path():
    engine = NativeAudioEngine(sample_rate=44100)
    audio = np.zeros(22050, dtype=np.float32)
    audio[0] = 1.0
    out = engine.process_bus(audio, "voice", intensity=0.5)
    assert out.shape == audio.shape
    assert out.dtype == np.float32


def test_process_bus_rejects_unknown_bus():
    engine = NativeAudioEngine()
    audio = np.zeros((2, 1024), dtype=np.float32)
    try:
        engine.process_bus(audio, "unknown-bus", intensity=0.5)
    except ValueError as exc:
        assert "Unknown bus_type" in str(exc)
    else:
        raise AssertionError("Expected ValueError for unknown bus_type")
