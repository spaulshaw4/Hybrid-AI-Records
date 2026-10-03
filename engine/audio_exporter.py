"""13-lane production package.

Stems are phase-aligned copies of the console lanes, written 24-bit / 48 kHz.
The master is their sum through the existing mastering bus. This module does
not change that bus.
"""
from __future__ import annotations

import json
import os
from math import gcd
from typing import Any, Mapping

import numpy as np
import soundfile as sf

PACKAGE_RATE = 48000
# Sum headroom before the mastering bus. A 13-lane sum past ±1 clips to a square wave.
SUM_HEADROOM = 10.0 ** (-3.0 / 20.0)
_PCM16 = 32768.0
_PCM24 = 8388607.0
_PCM32 = 2147483647.0

# Console lane id -> package filename without the extension.
STEM_EXPORT_IDS = {
    "01_kick": "01_kick",
    "02_snare": "02_snare",
    "03_tops": "03_tops_hats",
    "04_aux_perc": "04_percussion",
    "05_sub_bass": "05_sub_bass",
    "06_mid_bass": "06_mid_bass",
    "07_primary_comp": "07_primary_rhythm",
    "08_harmonic_bed": "08_harmonic_pads",
    "09_secondary_comp": "09_secondary_chops",
    "10_lead_inst": "10_lead_fills",
    "11_lead_vocal": "11_lead_vocal",
    "12_vocal_backing": "12_backing_vocals",
    "13_transitions_fx": "13_fx_risers",
}


class RenderSession:
    """Lane audio plus the manifest the exporter writes beside the master."""

    def __init__(
        self,
        lanes: Mapping[str, np.ndarray],
        manifest: Mapping[str, Any],
        sample_rate: int,
    ) -> None:
        self.lanes = {str(lane): _unit_float(audio) for lane, audio in lanes.items()}
        self.manifest = dict(manifest)
        self.sample_rate = int(sample_rate)

    def sum_lanes(self) -> np.ndarray:
        if not self.lanes:
            return np.zeros((0, 2), dtype=np.float64)
        prepared = [_stereo(audio) for audio in self.lanes.values()]
        length = max(audio.shape[0] for audio in prepared)
        mix = np.zeros((length, 2), dtype=np.float64)
        for audio in prepared:
            mix[: audio.shape[0]] += audio
        return _fit_headroom(mix)


def _unit_float(audio: np.ndarray) -> np.ndarray:
    """Map every buffer into float64 on [-1, 1]. Integer PCM is scaled, never wrapped."""
    arr = np.asarray(audio)
    if np.issubdtype(arr.dtype, np.integer):
        if arr.dtype == np.int32:
            peak_i = int(np.max(np.abs(arr))) if arr.size else 0
            scale = _PCM24 if peak_i <= int(_PCM24) else _PCM32
        else:
            info = np.iinfo(arr.dtype)
            scale = float(max(abs(int(info.min)), int(info.max)))
        arr = arr.astype(np.float64) / scale
    else:
        arr = np.asarray(arr, dtype=np.float64)
        peak = float(np.max(np.abs(arr))) if arr.size else 0.0
        if peak > 8.0:
            if peak <= _PCM16:
                arr = arr / _PCM16
            elif peak <= _PCM24 + 1.0:
                arr = arr / _PCM24
            else:
                arr = arr / _PCM32
        elif peak > 1.0:
            arr = arr / peak
    return arr


def _fit_headroom(audio: np.ndarray, ceiling: float = SUM_HEADROOM) -> np.ndarray:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > ceiling > 0.0:
        return audio * (ceiling / peak)
    return audio


def _stereo(audio: np.ndarray) -> np.ndarray:
    arr = _unit_float(audio)
    if arr.ndim == 1:
        arr = np.stack([arr, arr], axis=1)
    elif arr.shape[1] == 1:
        arr = np.repeat(arr, 2, axis=1)
    elif arr.shape[1] > 2:
        arr = arr[:, :2]
    return arr


def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if int(source_rate) == int(target_rate) or audio.size == 0:
        return audio
    try:
        from scipy.signal import resample_poly

        divisor = gcd(int(source_rate), int(target_rate)) or 1
        return np.asarray(
            resample_poly(audio, int(target_rate) // divisor, int(source_rate) // divisor, axis=0),
            dtype=np.float64,
        )
    except Exception:
        dst_len = max(1, int(round(audio.shape[0] * float(target_rate) / float(source_rate))))
        source_x = np.linspace(0.0, 1.0, audio.shape[0])
        target_x = np.linspace(0.0, 1.0, dst_len)
        if audio.ndim == 1:
            return np.interp(target_x, source_x, audio).astype(np.float64)
        return np.stack(
            [np.interp(target_x, source_x, audio[:, channel]) for channel in range(audio.shape[1])],
            axis=1,
        ).astype(np.float64)


def save_wav_pcm24(path: str, audio: np.ndarray, sample_rate: int = PACKAGE_RATE) -> str:
    """Pack unit-float audio as 24-bit PCM. soundfile scales [-1, 1]; values outside that clip to a square."""
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    packed = np.clip(_stereo(audio), -1.0, 1.0)
    sf.write(path, packed, int(sample_rate), subtype="PCM_24")
    return path


def process_master(master_mix: np.ndarray, sample_rate: int):
    """Run the existing mastering bus. The bus module itself is left alone."""
    from engine.mastering_bus import MasteringBus

    return MasteringBus().process(_stereo(master_mix), int(sample_rate))


def export_multitrack_package(render_session: RenderSession, output_dir: str) -> str:
    """Write 13 PCM24 stems, the mastered 2-track, and manifest.json."""
    os.makedirs(os.path.join(output_dir, "stems"), exist_ok=True)
    rate = PACKAGE_RATE
    exported: dict[str, np.ndarray] = {}
    for lane_id, lane_audio in render_session.lanes.items():
        audio = _resample(_stereo(lane_audio), render_session.sample_rate, rate)
        exported[lane_id] = audio
        save_wav_pcm24(os.path.join(output_dir, "stems", f"{lane_id}.wav"), audio, sample_rate=rate)
    session = RenderSession(exported, render_session.manifest, rate)
    master_mix = session.sum_lanes()
    report_payload: dict[str, Any] = {}
    try:
        final_master, report = process_master(master_mix, rate)
        report_payload = {
            "integrated_lufs": report.integrated_lufs,
            "true_peak_dbtp": report.true_peak_dbtp,
            "target_lufs": report.target_lufs,
            "ceiling_dbtp": report.ceiling_dbtp,
        }
    except Exception as exc:
        final_master = master_mix
        report_payload = {"error": f"{type(exc).__name__}: {exc}"}
        print(f"[PACKAGE] mastering skipped ({exc})", flush=True)
    save_wav_pcm24(os.path.join(output_dir, "master_full.wav"), final_master, sample_rate=rate)
    manifest = dict(render_session.manifest)
    manifest["sample_rate"] = rate
    manifest["bit_depth"] = 24
    manifest["master"] = "master_full.wav"
    manifest["mastering"] = report_payload
    manifest["stems"] = [f"stems/{lane_id}.wav" for lane_id in render_session.lanes]
    with open(os.path.join(output_dir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    print(f"[PACKAGE] {output_dir}", flush=True)
    return output_dir


def package_dir_for(session_dir: str, sequence: int, day: str) -> str:
    """``exports/song_YYYYMMDD_001`` under the session folder."""
    return os.path.join(session_dir, "exports", f"song_{day}_{int(sequence):03d}")


def load_console_lanes(files: Mapping[str, str]) -> tuple[dict[str, np.ndarray], int]:
    """Read each lane at its own rate, resample to 48 kHz, and rename to the package id.

    A decode failure becomes silence for that lane. Raw header bytes never enter the sum.
    """
    lanes: dict[str, np.ndarray] = {}
    for lane, path in files.items():
        export_id = STEM_EXPORT_IDS.get(str(lane), str(lane))
        if not path or not os.path.isfile(path):
            continue
        try:
            info = sf.info(path)
            audio, file_rate = sf.read(path, always_2d=True, dtype="float64")
        except Exception as exc:
            print(f"[PACKAGE] stem decode failed {path}: {type(exc).__name__}: {exc}", flush=True)
            continue
        audio = _resample(_unit_float(audio), int(file_rate or info.samplerate or PACKAGE_RATE), PACKAGE_RATE)
        lanes[export_id] = audio
    for export_id in STEM_EXPORT_IDS.values():
        if export_id not in lanes:
            length = max((audio.shape[0] for audio in lanes.values()), default=1)
            lanes[export_id] = np.zeros((length, 2), dtype=np.float64)
    ordered = {export_id: lanes[export_id] for export_id in STEM_EXPORT_IDS.values()}
    return ordered, PACKAGE_RATE
