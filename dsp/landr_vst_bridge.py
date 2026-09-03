"""Crash-safe LANDR VST3 bus processor with native fallback."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile

import numpy as np

from .native_audio_engine import NativeAudioEngine

DEFAULT_VST_DIR = r"C:\Program Files\Common Files\VST3\LANDR"
PLUGIN_FILES = {
    "acoustic": "LANDR FX Acoustic.vst3",
    "voice": "LANDR FX Voice.vst3",
    "bass": "LANDR FX Bass.vst3",
    "beats": "LANDR FX Beats.vst3",
    "electric": "LANDR FX Electric.vst3",
}


def _resolve_vst_binary(vst_dir: str, bus_type: str) -> str | None:
    filename = PLUGIN_FILES.get(bus_type)
    if not filename:
        return None
    bundle = os.path.join(vst_dir, filename)
    inner = os.path.join(bundle, "Contents", "x86_64-win", filename)
    if os.path.isfile(inner):
        return inner
    if os.path.isdir(bundle) or os.path.isfile(bundle):
        return bundle
    return None


def _first_parameter(plugin):
    params = getattr(plugin, "_parameters", None)
    if params:
        return params[0]
    names = list(plugin.parameters.keys())
    if not names:
        return None
    return plugin.parameters[names[0]]


def _worker(input_npy: str, output_npy: str, sr: int, bus_type: str, intensity: float, vst_dir: str) -> int:
    from pedalboard import load_plugin

    plugin_path = _resolve_vst_binary(vst_dir, bus_type)
    if not plugin_path:
        raise FileNotFoundError(f"LANDR VST3 not found for bus '{bus_type}' in {vst_dir}")

    audio = np.load(input_npy).astype(np.float32, copy=False)
    plugin = load_plugin(plugin_path, initialization_timeout=30.0)
    param = _first_parameter(plugin)
    if param is not None:
        param.raw_value = float(np.clip(intensity, 0.0, 1.0))
    reset = getattr(plugin, "reset", None)
    if callable(reset):
        reset()
    rendered = plugin(audio, int(sr))
    np.save(output_npy, np.asarray(rendered, dtype=np.float32))
    return 0


def apply_landr_bus_with_fallback(
    audio: np.ndarray,
    sr: int,
    bus_type: str,
    intensity: float = 0.5,
    *,
    prefer_vst: bool = True,
    vst_dir: str = DEFAULT_VST_DIR,
) -> np.ndarray:
    """Apply LANDR bus effect via VST3 worker, fallback to NativeAudioEngine."""
    bus = str(bus_type or "").strip().lower()
    arr = np.asarray(audio, dtype=np.float32)
    if bus not in PLUGIN_FILES:
        raise ValueError(f"Unsupported LANDR bus type: {bus_type}")

    if not prefer_vst:
        return NativeAudioEngine(sample_rate=sr).process_bus(arr, bus, intensity=float(intensity))

    with tempfile.TemporaryDirectory(prefix="landr_vst_bridge_") as td:
        inp = os.path.join(td, "in.npy")
        out = os.path.join(td, "out.npy")
        np.save(inp, arr)
        cmd = [
            sys.executable,
            os.path.abspath(__file__),
            "--worker",
            "--input-npy",
            inp,
            "--output-npy",
            out,
            "--sr",
            str(int(sr)),
            "--bus-type",
            bus,
            "--intensity",
            str(float(intensity)),
            "--vst-dir",
            vst_dir,
        ]
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
        if proc.returncode == 0 and os.path.isfile(out):
            try:
                return np.load(out).astype(np.float32, copy=False)
            except Exception:
                pass
    return NativeAudioEngine(sample_rate=sr).process_bus(arr, bus, intensity=float(intensity))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LANDR VST3 worker bridge")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--input-npy", default="")
    parser.add_argument("--output-npy", default="")
    parser.add_argument("--sr", type=int, default=44100)
    parser.add_argument("--bus-type", default="")
    parser.add_argument("--intensity", type=float, default=0.5)
    parser.add_argument("--vst-dir", default=DEFAULT_VST_DIR)
    args = parser.parse_args(argv)
    if not args.worker:
        return 2
    return _worker(
        input_npy=args.input_npy,
        output_npy=args.output_npy,
        sr=args.sr,
        bus_type=args.bus_type,
        intensity=args.intensity,
        vst_dir=args.vst_dir,
    )


if __name__ == "__main__":
    raise SystemExit(main())
