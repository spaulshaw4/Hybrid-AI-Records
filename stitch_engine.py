#!/usr/bin/env python3
"""Download R2 stems, time-stretch / pitch-shift, mix, and upload a master."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from arranger import arrange_stem_layer
from audio_telemetry import enforce_safety_limiting, validate_and_log_master
from audio_transcoder import transcode_and_tag
from drum_quantizer import quantize_drum_array
from mastering import apply_mastering_chain
from rubberband_engine import align_audio, apply_rubberband
from sidechain import duck_backing_array
from r2_uploader import (
    R2_BUCKET_NAME,
    public_url_for_key,
    s3_client,
    upload_file_to_r2_fast,
)

TARGET_SR = 44100
CONTENT_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "aac": "audio/mp4",
    "m4a": "audio/mp4",
}


def download_stem(r2_key: str, local_dest: str) -> None:
    s3_client.download_file(R2_BUCKET_NAME, r2_key, local_dest)


def upload_rendered_mix(local_file: str, remote_key: str, content_type: str = "audio/wav") -> None:
    upload_file_to_r2_fast(local_file, remote_key, content_type=content_type)
    print(f"Rendered mix uploaded to: {remote_key}")


def process_and_align_stem(
    file_path: str,
    src_bpm: float,
    target_bpm: float,
    source_key: str = "",
    target_key: str = "",
    stem_type: str = "",
    semitone_shift: int | None = None,
) -> np.ndarray:
    y, sr = librosa.load(file_path, sr=TARGET_SR, mono=False)
    aligned, metrics = align_audio(
        y,
        sr,
        source_bpm=src_bpm,
        target_bpm=target_bpm,
        source_key=source_key,
        target_key=target_key,
        stem_type=stem_type,
    )
    if (
        stem_type != "drums"
        and metrics["semitone_shift"] == 0
        and semitone_shift not in (None, 0)
    ):
        rate = (target_bpm / src_bpm) if src_bpm and target_bpm else 1.0
        aligned = apply_rubberband(y, sr, n_steps=int(semitone_shift), rate=rate)
        metrics = {
            "tempo_ratio": round(float(rate), 3),
            "semitone_shift": int(semitone_shift),
            "is_drum": False,
        }
    print(
        f"Aligned {stem_type or file_path} -> Shift: {metrics['semitone_shift']}st | "
        f"Ratio: {metrics['tempo_ratio']}x"
    )
    return aligned


def _distribution_keys(output_key: str) -> dict[str, str]:
    posix = output_key.replace("\\", "/")
    parent = posix.rsplit("/", 1)[0] if "/" in posix else "renders"
    stem = Path(output_key).stem
    return {
        "wav": output_key,
        "mp3": f"{parent}/{stem}.mp3",
        "aac": f"{parent}/{stem}.m4a",
    }


def render_composition(
    tracks_config: list,
    target_bpm: float,
    output_key: str,
    job_id: str | None = None,
    metadata: dict | None = None,
    target_key: str | None = None,
) -> dict:
    meta = metadata or {}
    recipe_key = target_key or meta.get("target_key") or ""
    with tempfile.TemporaryDirectory() as tmpdir:
        processed_layers: list[tuple[str, np.ndarray]] = []
        print(f"\n--- Rendering composition to {target_bpm} BPM ---")

        for idx, item in enumerate(tracks_config):
            stem_name = str(item.get("stem") or "")
            r2_key = f"stems/{item['track_id']}/{stem_name}.wav"
            local_wav = os.path.join(tmpdir, f"layer_{idx}_{stem_name}.wav")
            print(f"Downloading R2 stem: {r2_key}")
            download_stem(r2_key, local_wav)

            processed_audio = process_and_align_stem(
                local_wav,
                src_bpm=item.get("src_bpm", target_bpm),
                target_bpm=target_bpm,
                source_key=str(item.get("source_key") or ""),
                target_key=recipe_key,
                stem_type=stem_name,
                semitone_shift=item.get("pitch_shift"),
            )

            gain_linear = 10.0 ** (item.get("gain_db", 0.0) / 20.0)
            processed_audio = processed_audio * gain_linear

            if processed_audio.ndim == 1:
                processed_audio = np.vstack([processed_audio, processed_audio])

            if stem_name == "drums":
                processed_audio, qmeta = quantize_drum_array(
                    processed_audio,
                    TARGET_SR,
                    target_bpm,
                    subdivision=16,
                    strength=0.90,
                )
                if qmeta.get("quantized"):
                    print(
                        f"Drum Transient Grid Lock: {qmeta.get('transients_detected', 0)} "
                        f"hits aligned to {target_bpm} BPM."
                    )

            processed_audio = arrange_stem_layer(processed_audio, stem_name)
            processed_layers.append((stem_name, processed_audio))

        vocal_audio = next((audio for name, audio in processed_layers if name == "vocals"), None)
        if vocal_audio is not None:
            ducked_layers: list[tuple[str, np.ndarray]] = []
            for stem_name, audio in processed_layers:
                if stem_name in {"other", "bass"}:
                    audio = duck_backing_array(
                        audio,
                        vocal_audio,
                        sr=TARGET_SR,
                        max_ducking_db=-3.0,
                        attack_ms=12.0,
                        release_ms=180.0,
                    )
                    print(f"Sidechain ducking applied to '{stem_name}' against vocal envelope.")
                ducked_layers.append((stem_name, audio))
            processed_layers = ducked_layers

        max_len = max((audio.shape[1] for _, audio in processed_layers), default=0)
        mixed = np.zeros((2, max_len), dtype=np.float32)
        for _, layer in processed_layers:
            mixed[:, : layer.shape[1]] += layer.astype(np.float32)

        landr_bus = meta.get("landr_bus_type") or meta.get("landr_bus")
        landr_intensity = float(meta.get("landr_intensity") or 0.5)
        final_master = apply_mastering_chain(
            mixed,
            TARGET_SR,
            target_lufs=-14.0,
            landr_bus_type=landr_bus if isinstance(landr_bus, str) and landr_bus else None,
            landr_intensity=landr_intensity,
            landr_prefer_vst=True,
        )
        render_path = os.path.join(tmpdir, "render_output.wav")
        sf.write(render_path, final_master.T, TARGET_SR, subtype="PCM_24")
        qc_job_id = job_id or Path(output_key).stem
        metrics = enforce_safety_limiting(render_path, max_true_peak_dbfs=-0.5)

        encoded = transcode_and_tag(
            source_wav_path=render_path,
            title=meta.get("title") or f"Mix {qc_job_id[:8]}",
            artist=meta.get("artist") or "Hybrid AI Engine",
            album=meta.get("album") or "AI Stems Master Series",
            bpm=target_bpm,
            cover_image_path=meta.get("cover_image_path"),
        )
        r2_keys = _distribution_keys(output_key)
        upload_rendered_mix(encoded["wav"], r2_keys["wav"], content_type=CONTENT_TYPES["wav"])
        upload_rendered_mix(encoded["mp3"], r2_keys["mp3"], content_type=CONTENT_TYPES["mp3"])
        upload_rendered_mix(encoded["aac"], r2_keys["aac"], content_type=CONTENT_TYPES["aac"])

        urls = {
            "wav": public_url_for_key(r2_keys["wav"]),
            "mp3": public_url_for_key(r2_keys["mp3"]),
            "aac": public_url_for_key(r2_keys["aac"]),
        }
        metrics = validate_and_log_master(
            qc_job_id,
            render_path,
            r2_key=output_key,
            metrics=metrics,
            urls=urls,
        )
        return {"metrics": metrics, "urls": urls, "r2_keys": r2_keys}


if __name__ == "__main__":
    sample_recipe = [
        {"track_id": "000002", "stem": "drums", "src_bpm": 120.0, "pitch_shift": 0, "gain_db": 0.0},
        {"track_id": "000005", "stem": "bass", "src_bpm": 120.0, "pitch_shift": 0, "gain_db": -2.0},
    ]
    render_composition(sample_recipe, target_bpm=120.0, output_key="renders/test_mix_01.wav")
