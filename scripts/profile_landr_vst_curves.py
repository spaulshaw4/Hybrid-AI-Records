"""Impulse-sweep LANDR FX VST3 macros and write frequency-response JSON.

Loads the Acoustic / Voice / Bass / Beats / Electric suite from the standard
Windows VST3 folder, drives the first exposed parameter (macro intensity)
across 0..1, and records rFFT magnitude at fixed bands.

Each plugin is profiled in a child process so a host crash cannot take down
the rest of the suite. Missing plugs are skipped.

Requires the LANDR VST3s on this machine and pedalboard + numpy.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

DEFAULT_VST_DIR = r"C:\Program Files\Common Files\VST3\LANDR"
PLUGIN_FILES = {
    "acoustic": "LANDR FX Acoustic.vst3",
    "voice": "LANDR FX Voice.vst3",
    "bass": "LANDR FX Bass.vst3",
    "beats": "LANDR FX Beats.vst3",
    "electric": "LANDR FX Electric.vst3",
}
SAMPLE_RATE = 44100
FREQUENCIES_TO_MEASURE = (40, 80, 150, 300, 500, 1000, 2500, 5000, 8000, 12000, 16000)
DIAL_SETTINGS = (0.0, 0.25, 0.5, 0.75, 1.0)
DEFAULT_OUTPUT = os.path.join(REPO, "dsp", "landr_dsp_curves.json")
INSTALLER_DIRS = {
    "acoustic": r"C:\Program Files (x86)\LANDR\LANDR FX Acoustic",
    "voice": r"C:\Program Files (x86)\LANDR\LANDR FX Voice",
    "bass": r"C:\Program Files (x86)\LANDR\LANDR FX Bass",
    "beats": r"C:\Program Files (x86)\LANDR\LANDR FX Beats",
    "electric": r"C:\Program Files (x86)\LANDR\LANDR FX Electric",
}


def _plugin_exists(path: str) -> bool:
    return os.path.isdir(path) or os.path.isfile(path)


def resolve_plugin_path(bundle_or_file: str) -> str:
    """Prefer the Windows inner binary; Pedalboard often cannot scan the bundle."""
    inner = os.path.join(bundle_or_file, "Contents", "x86_64-win", os.path.basename(bundle_or_file))
    if os.path.isfile(inner):
        return inner
    return bundle_or_file


def _first_parameter(plugin: Any) -> Any | None:
    params = getattr(plugin, "_parameters", None)
    if params:
        return params[0]
    names = list(plugin.parameters.keys())
    if not names:
        return None
    return plugin.parameters[names[0]]


def _nearest_bin_indices(freq_bins: np.ndarray, targets_hz: tuple[int, ...]) -> dict[int, int]:
    return {hz: int(np.argmin(np.abs(freq_bins - hz))) for hz in targets_hz}


def _measure_bands(rendered: np.ndarray, sample_rate: int) -> dict[str, float]:
    channel = rendered[0] if rendered.ndim == 2 else rendered
    fft_response = np.fft.rfft(channel)
    magnitude_db = 20 * np.log10(np.abs(fft_response) + 1e-9)
    freq_bins = np.fft.rfftfreq(channel.shape[-1], 1.0 / sample_rate)
    indices = _nearest_bin_indices(freq_bins, FREQUENCIES_TO_MEASURE)
    return {
        f"{hz}Hz": round(float(magnitude_db[indices[hz]]), 2) for hz in FREQUENCIES_TO_MEASURE
    }


def _impulse(sample_rate: int) -> np.ndarray:
    # Pedalboard process() expects (channels, samples).
    impulse = np.zeros((2, sample_rate), dtype=np.float32)
    impulse[:, 0] = 1.0
    return impulse


def profile_plugin(path: str, sample_rate: int) -> dict[str, Any]:
    from pedalboard import load_plugin

    plugin = load_plugin(path, initialization_timeout=30.0)
    param = _first_parameter(plugin)
    param_name = getattr(param, "name", None) if param is not None else None
    curves: dict[str, Any] = {
        "_meta": {"plugin_path": path, "macro_parameter": param_name},
    }
    for val in DIAL_SETTINGS:
        if param is not None:
            try:
                param.raw_value = float(val)
            except Exception as exc:
                print(f"    warning: could not set {param_name!r} to {val}: {exc}", file=sys.stderr)
        reset = getattr(plugin, "reset", None)
        if callable(reset):
            reset()
        rendered = plugin(_impulse(sample_rate), sample_rate)
        key = f"setting_{val}"
        curves[key] = _measure_bands(np.asarray(rendered), sample_rate)
        print(f"    {key}: {curves[key]}", file=sys.stderr)
    return curves


def _worker_main(path: str, sample_rate: int) -> int:
    try:
        json.dump(profile_plugin(path, sample_rate), sys.stdout)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:
        json.dump({"_meta": {"plugin_path": path, "error": str(exc)}}, sys.stdout)
        sys.stdout.write("\n")
        return 1


def _profile_in_subprocess(
    name: str, path: str, sample_rate: int
) -> dict[str, Any]:
    cmd = [
        sys.executable,
        os.path.abspath(__file__),
        "--worker",
        "--plugin-path",
        path,
        "--sample-rate",
        str(sample_rate),
    ]
    cwd = INSTALLER_DIRS.get(name)
    if cwd and not os.path.isdir(cwd):
        cwd = None
    try:
        completed = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            cwd=cwd or REPO,
        )
    except OSError as exc:
        return {"_meta": {"plugin_path": path, "error": f"failed to spawn worker: {exc}"}}

    if completed.stderr:
        sys.stderr.write(completed.stderr)
        if not completed.stderr.endswith("\n"):
            sys.stderr.write("\n")

    if completed.returncode == 0 and completed.stdout.strip():
        return json.loads(completed.stdout)

    if completed.returncode < 0 or completed.returncode == 0xC0000005:
        return {
            "_meta": {
                "plugin_path": path,
                "error": (
                    f"Pedalboard/JUCE host crashed while loading this VST3 "
                    f"(exit={completed.returncode})."
                ),
            }
        }

    if completed.stdout.strip():
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError:
            pass
    err = completed.stderr.strip() or f"worker exited {completed.returncode}"
    return {"_meta": {"plugin_path": path, "error": err}}


def profile_suite(vst_dir: str, sample_rate: int) -> dict[str, Any]:
    dsp_profile_data: dict[str, Any] = {}
    for name, filename in PLUGIN_FILES.items():
        bundle = os.path.join(vst_dir, filename)
        if not _plugin_exists(bundle):
            print(f"Skipping {name}: file not found at {bundle}")
            continue
        path = resolve_plugin_path(bundle)
        print(f"Profiling DSP: {name.upper()} ({path})...")
        result = _profile_in_subprocess(name, path, sample_rate)
        error = (result.get("_meta") or {}).get("error")
        if error:
            print(f"  failed: {error}")
        dsp_profile_data[name] = result
    return dsp_profile_data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Profile LANDR FX VST3 impulse curves.")
    parser.add_argument("--vst-dir", default=DEFAULT_VST_DIR)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--sample-rate", type=int, default=SAMPLE_RATE)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--plugin-path", default="")
    args = parser.parse_args(argv)

    if args.worker:
        if not args.plugin_path:
            print("--worker requires --plugin-path", file=sys.stderr)
            return 2
        return _worker_main(args.plugin_path, args.sample_rate)

    data = profile_suite(args.vst_dir, args.sample_rate)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=4)
        handle.write("\n")
    ok = [name for name, body in data.items() if "setting_0.0" in body]
    print(f"\nDSP curves written to {args.output}")
    print(f"Profiled: {', '.join(ok) or '(none)'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
