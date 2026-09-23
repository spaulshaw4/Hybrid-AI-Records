"""Module 5 — Stem packager: WAV/MP3 export, manifest, zip archive."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import soundfile as sf

from engine.mastering_bus import MasteringReport
from engine.provenance_guard import ProvenanceReport

# Delivery stem filenames (Module 5 brief).
STEM_FILES = (
    "drums.wav",
    "bass.wav",
    "rhythm_guitar.wav",
    "lead_guitar.wav",
    "synth.wav",
    "vocals.wav",
)

# Mixer / assembly bus → delivery stem name(s).
BUS_TO_STEMS: dict[str, tuple[str, ...]] = {
    "rhythm": ("drums.wav",),
    "bass": ("bass.wav",),
    "harmonic": ("rhythm_guitar.wav", "lead_guitar.wav", "synth.wav"),
    "vocal": ("vocals.wav",),
}

# Linear sample-peak ceiling for exported stems (~ -0.54 dBFS).
STEM_PEAK_CEILING = 0.94


@dataclass
class PackageResult:
    project_dir: str
    master_wav: str
    master_mp3: str | None
    stem_paths: dict[str, str]
    manifest_path: str
    zip_path: str
    stems_dir: str = ""
    urls: dict[str, str] = field(default_factory=dict)
    manifest: dict[str, Any] = field(default_factory=dict)


def export_delivery_bundle(
    session_id: str,
    output_root: str = "output/deliveries",
) -> tuple[Path, Path]:
    """Create the delivery pack directories up-front so exports never fail silently.

    Layout::

        {output_root}/{session_id}/
        ├── master.wav
        ├── master.mp3
        ├── manifest.json
        ├── stems/
        │   ├── drums.wav
        │   └── ...
        └── {session_id}_stems_bundle.zip
    """
    delivery_dir = Path(output_root) / session_id
    stems_dir = delivery_dir / "stems"
    delivery_dir.mkdir(parents=True, exist_ok=True)
    stems_dir.mkdir(parents=True, exist_ok=True)
    if not delivery_dir.is_dir() or not stems_dir.is_dir():
        raise RuntimeError(
            f"Failed to create delivery directories: delivery={delivery_dir} stems={stems_dir}"
        )
    return delivery_dir, stems_dir


def _ensure_stereo(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return np.column_stack((data, data))
    if data.shape[1] == 1:
        return np.repeat(data, 2, axis=1)
    return data[:, :2]


def _write_pcm24(path: str, audio: np.ndarray, sr: int) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    sf.write(path, _ensure_stereo(audio), int(sr), subtype="PCM_24")


def _ffmpeg_mp3(wav_path: str, mp3_path: str, bitrate: str = "320k") -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        # Common Windows WinGet install location when PATH is incomplete.
        winget = Path.home() / (
            "AppData/Local/Microsoft/WinGet/Packages"
        )
        if winget.is_dir():
            for candidate in winget.rglob("ffmpeg.exe"):
                ffmpeg = str(candidate)
                break
    if not ffmpeg:
        return False
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        wav_path,
        "-codec:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        mp3_path,
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
        )
        return proc.returncode == 0 and os.path.isfile(mp3_path)
    except OSError:
        return False


def map_buses_to_delivery_stems(
    stems: Mapping[str, np.ndarray],
) -> dict[str, np.ndarray]:
    """Expand 4-bus mixer stems into the six delivery filenames."""
    out: dict[str, np.ndarray] = {}
    rhythm = stems.get("rhythm")
    bass = stems.get("bass")
    harmonic = stems.get("harmonic")
    vocal = stems.get("vocal")
    # Prefer explicit named keys when callers already provide them.
    aliases = {
        "drums.wav": stems.get("drums", rhythm),
        "bass.wav": stems.get("bass_stem", bass),
        "rhythm_guitar.wav": stems.get("rhythm_guitar", harmonic),
        "lead_guitar.wav": stems.get("lead_guitar", stems.get("lead")),
        "synth.wav": stems.get("synth"),
        "vocals.wav": stems.get("vocals", stems.get("vocal", vocal)),
    }
    ref = None
    for audio in aliases.values():
        if audio is not None and np.asarray(audio).size:
            ref = np.asarray(audio)
            break
    n = int(ref.shape[0]) if ref is not None else 0
    ch_shape = (n,) if ref is None or ref.ndim == 1 else (n, ref.shape[1])

    def _silence() -> np.ndarray:
        return np.zeros(ch_shape, dtype=np.float64)

    out["drums.wav"] = np.asarray(aliases["drums.wav"] if aliases["drums.wav"] is not None else _silence())
    out["bass.wav"] = np.asarray(aliases["bass.wav"] if aliases["bass.wav"] is not None else _silence())
    harm = aliases["rhythm_guitar.wav"]
    out["rhythm_guitar.wav"] = np.asarray(harm if harm is not None else _silence())
    lead = aliases["lead_guitar.wav"]
    if lead is None and harm is not None:
        lead = np.asarray(harm, dtype=np.float64) * 0.85
    out["lead_guitar.wav"] = np.asarray(lead if lead is not None else _silence())
    synth = aliases["synth.wav"]
    if synth is None and harm is not None:
        synth = np.asarray(harm, dtype=np.float64) * 0.65
    out["synth.wav"] = np.asarray(synth if synth is not None else _silence())
    out["vocals.wav"] = np.asarray(
        aliases["vocals.wav"] if aliases["vocals.wav"] is not None else _silence()
    )
    # Align lengths.
    max_n = max((a.shape[0] for a in out.values()), default=0)
    for key, audio in list(out.items()):
        if audio.shape[0] < max_n:
            pad = max_n - audio.shape[0]
            if audio.ndim == 1:
                out[key] = np.pad(audio, (0, pad))
            else:
                out[key] = np.pad(audio, ((0, pad), (0, 0)))
        elif audio.shape[0] > max_n:
            out[key] = audio[:max_n]
    return out


class StemPackager:
    """Write time-aligned stems, master, manifest.json, and a distribution zip."""

    def __init__(
        self,
        project_dir: str,
        *,
        sr: int = 44100,
        public_base_url: str = "/api/stream",
    ) -> None:
        self.project_dir = os.path.abspath(project_dir)
        self.sr = int(sr)
        self.public_base_url = public_base_url.rstrip("/")

    def package(
        self,
        *,
        master: np.ndarray,
        stems: Mapping[str, np.ndarray],
        song_plan: Mapping[str, Any] | None = None,
        mastering: MasteringReport | Mapping[str, Any] | None = None,
        provenance: ProvenanceReport | Mapping[str, Any] | None = None,
        session_id: str | None = None,
        extra_manifest: Mapping[str, Any] | None = None,
    ) -> PackageResult:
        sid = session_id or os.path.basename(self.project_dir) or "delivery"
        # Explicit directory creation (parents + stems/) so automated runs
        # never fail silently when the delivery root is missing.
        delivery_dir = Path(self.project_dir)
        stems_dir = delivery_dir / "stems"
        delivery_dir.mkdir(parents=True, exist_ok=True)
        stems_dir.mkdir(parents=True, exist_ok=True)
        if not delivery_dir.is_dir() or not stems_dir.is_dir():
            raise RuntimeError(
                f"Failed to create delivery directories: "
                f"delivery={delivery_dir} stems={stems_dir}"
            )
        self.project_dir = str(delivery_dir.resolve())

        delivery = map_buses_to_delivery_stems(stems)
        # Zero-pad every stem to master length so the pack is time-aligned.
        master_arr = _ensure_stereo(master)
        target_n = int(master_arr.shape[0])
        for name, audio in list(delivery.items()):
            audio = _ensure_stereo(audio)
            if audio.shape[0] < target_n:
                pad = target_n - audio.shape[0]
                audio = np.pad(audio, ((0, pad), (0, 0)))
            elif audio.shape[0] > target_n:
                audio = audio[:target_n]
            delivery[name] = audio

        # One uniform trim across all stems keeps their relative balance while
        # keeping every sample peak inside 24-bit PCM range.
        max_stem_peak = max(
            (float(np.max(np.abs(a))) for a in delivery.values() if a.size),
            default=0.0,
        )
        stem_trim = (
            float(STEM_PEAK_CEILING / max_stem_peak)
            if max_stem_peak > STEM_PEAK_CEILING
            else 1.0
        )
        stem_paths: dict[str, str] = {}
        for name, audio in delivery.items():
            path = str(stems_dir / name)
            _write_pcm24(path, audio * stem_trim, self.sr)
            stem_paths[name] = path

        master_wav = str(delivery_dir / "master.wav")
        _write_pcm24(master_wav, master_arr, self.sr)
        master_mp3 = str(delivery_dir / "master.mp3")
        mp3_ok = _ffmpeg_mp3(master_wav, master_mp3)
        master_mp3_path = master_mp3 if mp3_ok else None

        mastering_dict: dict[str, Any]
        if isinstance(mastering, MasteringReport):
            mastering_dict = {
                "integrated_lufs": mastering.integrated_lufs,
                "true_peak_dbtp": mastering.true_peak_dbtp,
                "target_lufs": mastering.target_lufs,
                "ceiling_dbtp": mastering.ceiling_dbtp,
                "phase_correlation": mastering.phase_correlation,
                "gain_db": mastering.gain_db,
                "details": mastering.details,
            }
        else:
            mastering_dict = dict(mastering or {})

        if isinstance(provenance, ProvenanceReport):
            provenance_dict = provenance.to_dict()
        else:
            provenance_dict = dict(provenance or {})

        plan = dict(song_plan or {})
        genre_vector = plan.get("genre_blend") or plan.get("genre_vector") or {}
        stamp = datetime.now(timezone.utc).isoformat()
        similarity = provenance_dict.get("max_similarity")
        manifest: dict[str, Any] = {
            "generated_at": stamp,
            "session_id": session_id or sid,
            "sample_rate": self.sr,
            "bit_depth": 24,
            "stem_gain_db": round(20.0 * float(np.log10(stem_trim)), 3),
            "stem_peak_dbfs_pre_trim": (
                round(20.0 * float(np.log10(max_stem_peak)), 3) if max_stem_peak > 0 else None
            ),
            "song_plan": plan,
            "genre_vector": genre_vector,
            "loudness": {
                "integrated_lufs": mastering_dict.get("integrated_lufs"),
                "true_peak_dbtp": mastering_dict.get("true_peak_dbtp"),
                "target_lufs": mastering_dict.get("target_lufs", -14.0),
            },
            "mastering": mastering_dict,
            "provenance": provenance_dict,
            "provenance_certification_hash": provenance_dict.get("certification_hash"),
            "provenance_similarity_score": similarity,
            "files": {
                "master_wav": "master.wav",
                "master_mp3": "master.mp3" if master_mp3_path else None,
                "stems_dir": "stems",
                "stems": [f"stems/{name}" for name in STEM_FILES],
                "zip": f"{sid}_stems_bundle.zip",
            },
        }
        if extra_manifest:
            manifest.update(dict(extra_manifest))

        manifest_path = str(delivery_dir / "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)

        zip_name = f"{sid}_stems_bundle.zip"
        zip_path = str(delivery_dir / zip_name)
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(master_wav, arcname="master.wav")
            if master_mp3_path:
                zf.write(master_mp3_path, arcname="master.mp3")
            zf.write(manifest_path, arcname="manifest.json")
            for name, path in stem_paths.items():
                zf.write(path, arcname=f"stems/{name}")

        def _url(filename: str) -> str:
            return f"{self.public_base_url}/{filename}"

        urls = {
            "master_url": _url(f"{sid}_master.wav") if session_id else _url("master.wav"),
            "master_wav": _url(f"{sid}_master.wav") if session_id else _url("master.wav"),
            "master_mp3": _url(f"{sid}_master.mp3") if master_mp3_path and session_id else (
                _url("master.mp3") if master_mp3_path else None
            ),
            "mp3_url": _url(f"{sid}_master.mp3") if master_mp3_path and session_id else (
                _url("master.mp3") if master_mp3_path else None
            ),
            "manifest": _url(f"{sid}_manifest.json") if session_id else _url("manifest.json"),
            "manifest_url": _url(f"{sid}_manifest.json") if session_id else _url("manifest.json"),
            "zip": _url(f"{sid}_stems_bundle.zip"),
            "zip_url": _url(f"{sid}_stems_bundle.zip"),
            "stems": {
                name: _url(f"{sid}_{name}" if session_id else f"stems/{name}")
                for name in STEM_FILES
            },
            "project_dir": self.project_dir,
            "stems_dir": str(stems_dir),
        }
        manifest["urls"] = urls
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)

        return PackageResult(
            project_dir=self.project_dir,
            master_wav=master_wav,
            master_mp3=master_mp3_path,
            stem_paths=stem_paths,
            manifest_path=manifest_path,
            zip_path=zip_path,
            stems_dir=str(stems_dir),
            urls={k: v for k, v in urls.items() if v is not None},
            manifest=manifest,
        )
