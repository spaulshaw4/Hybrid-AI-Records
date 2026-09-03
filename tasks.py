import os
from pathlib import Path

import numpy as np
import soundfile as sf
from celery import Celery
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from audio_telemetry import enforce_safety_limiting, validate_and_log_master
from audio_transcoder import transcode_and_tag
from mastering import apply_mastering_chain
from r2_uploader import public_url_for_key, s3_client, upload_file_to_r2_fast
from sidechain import apply_dynamic_vocal_ducking
from stitch_engine import R2_BUCKET_NAME, render_composition
from vocal_processor import polish_user_vocal
from webhook_auth import canonical_webhook_body, generate_webhook_signature

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
celery_app = Celery("audio_engine", broker=REDIS_URL, backend=REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
)

CONTENT_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "aac": "audio/mp4",
    "m4a": "audio/mp4",
}
ROOT = Path(__file__).resolve().parent


def _frontend_webhook_url() -> str | None:
    url = (
        os.environ.get("FRONTEND_WEBHOOK_URL")
        or os.environ.get("RENDER_WEBHOOK_URL")
        or ""
    ).strip()
    if not url or "your-hybrid-frontend.com" in url:
        return None
    return url


def _webhook_session():
    import requests

    session = requests.Session()
    retry_kwargs = {
        "total": 3,
        "backoff_factor": 0.5,
        "status_forcelist": (500, 502, 503, 504),
    }
    try:
        retry = Retry(allowed_methods=frozenset(["POST"]), **retry_kwargs)
    except TypeError:
        retry = Retry(method_whitelist=frozenset(["POST"]), **retry_kwargs)
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.mount("http://", HTTPAdapter(max_retries=retry))
    return session


def dispatch_webhook(webhook_url: str | None, payload: dict) -> None:
    if not webhook_url:
        return
    try:
        body = canonical_webhook_body(payload)
        headers = {"Content-Type": "application/json"}
        signature = generate_webhook_signature(payload)
        if signature:
            headers["X-Hybrid-Signature"] = signature
        res = _webhook_session().post(
            webhook_url,
            data=body.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
        print(f"[webhook] POST {webhook_url} -> {res.status_code}")
    except Exception as exc:
        print(f"[webhook] failed: {exc}")


def ping_frontend_webhook(
    job_id: str,
    final_url: str | None,
    task_status: str = "SUCCESS",
    webhook_url: str | None = None,
) -> None:
    url = webhook_url or _frontend_webhook_url()
    dispatch_webhook(
        url,
        {
            "job_id": job_id,
            "status": task_status,
            "master_audio_url": final_url,
        },
    )


def update_render_progress(job_id: str, step: str, progress, message: str = "") -> None:
    try:
        import requests

        headers = {}
        token = (os.environ.get("INTERNAL_BROADCAST_TOKEN") or "").strip()
        if token:
            headers["X-Internal-Token"] = token
        requests.post(
            "http://127.0.0.1:8000/api/internal/broadcast",
            json={
                "job_id": job_id,
                "step": step,
                "progress": progress,
                "message": message,
            },
            headers=headers,
            timeout=2,
        )
    except Exception:
        pass


def _presign(key: str) -> str:
    return s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": R2_BUCKET_NAME, "Key": key},
        ExpiresIn=86400,
    )


def scratch_dir() -> Path:
    if Path("/workspace").is_dir():
        path = Path("/workspace/scratch")
    else:
        path = ROOT / ".ingest_vault"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _channels_first(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        return np.vstack([data, data])
    if data.shape[0] == 2 and data.shape[0] < data.shape[1]:
        return data
    return data.T


def _mix_vocal_instrumental(vocal: np.ndarray, instrumental: np.ndarray) -> np.ndarray:
    v = _channels_first(vocal).astype(np.float32)
    inst = _channels_first(instrumental).astype(np.float32)
    n = min(v.shape[1], inst.shape[1])
    if n <= 0:
        raise RuntimeError("Empty vocal or instrumental buffer.")
    return (0.707 * (v[:, :n] + inst[:, :n])).astype(np.float32)


@celery_app.task(bind=True)
def render_audio_task(
    self,
    job_id: str,
    layers: list,
    target_bpm: float,
    metadata: dict | None = None,
    webhook_url: str | None = None,
    target_key: str | None = None,
):
    output_key = f"renders/{job_id}.wav"
    meta = metadata or {}
    hook = webhook_url or _frontend_webhook_url()
    try:
        update_render_progress(job_id, "started", 5, "Render started")
        rendered = render_composition(
            layers,
            target_bpm=target_bpm,
            output_key=output_key,
            job_id=job_id,
            metadata=meta,
            target_key=target_key,
        )
        urls = rendered.get("urls") or {}
        result = {
            "job_id": job_id,
            "status": "completed",
            "r2_key": output_key,
            "download_url": _presign(output_key),
            "urls": urls,
            "metrics": rendered.get("metrics"),
            "metadata": meta,
        }
        update_render_progress(job_id, "mastering", 90, "Master ready")
        dispatch_webhook(hook, result)
        ping_frontend_webhook(
            job_id,
            urls.get("wav") or result["download_url"],
            task_status="SUCCESS",
            webhook_url=hook,
        )
        update_render_progress(job_id, "complete", 100, "Render complete")
        return result
    except Exception as exc:
        update_render_progress(job_id, "failed", 0, "Render failed")
        dispatch_webhook(
            hook,
            {
                "job_id": job_id,
                "status": "failed",
                "error": str(exc),
                "metadata": meta,
            },
        )
        ping_frontend_webhook(job_id, None, task_status="failed", webhook_url=hook)
        raise


@celery_app.task(bind=True)
def hybrid_vocal_mix_task(
    self,
    job_id: str,
    instrumental_job_id: str,
    vocal_path: str,
    metadata: dict | None = None,
    webhook_url: str | None = None,
):
    meta = metadata or {}
    hook = webhook_url or _frontend_webhook_url()
    work = scratch_dir() / job_id
    work.mkdir(parents=True, exist_ok=True)
    try:
        inst_local = str(work / "instrumental.wav")
        s3_client.download_file(
            R2_BUCKET_NAME,
            f"renders/{instrumental_job_id}.wav",
            inst_local,
        )
        update_render_progress(job_id, "polish vocal", 15, "Polishing vocal")
        polished = str(work / "vocal_polished.wav")
        polish_user_vocal(vocal_path, polished)

        update_render_progress(job_id, "ducking", 40, "Applying vocal ducking")
        ducked = str(work / "instrumental_ducked.wav")
        apply_dynamic_vocal_ducking(
            backing_path=inst_local,
            vocal_path=polished,
            output_path=ducked,
            max_ducking_db=-4.0,
            attack_ms=12.0,
            release_ms=180.0,
        )

        update_render_progress(job_id, "mix", 60, "Mixing vocal and instrumental")
        vocal_audio, vocal_sr = sf.read(polished, dtype="float32")
        inst_audio, inst_sr = sf.read(ducked, dtype="float32")
        sr = int(vocal_sr or inst_sr or 44100)
        mixed = _mix_vocal_instrumental(vocal_audio, inst_audio)
        update_render_progress(job_id, "mastering", 75, "Mastering mix")
        landr_bus = meta.get("landr_bus_type") or meta.get("landr_bus")
        landr_intensity = float(meta.get("landr_intensity") or 0.5)
        mastered = apply_mastering_chain(
            mixed,
            sr=sr,
            target_lufs=-14.0,
            landr_bus_type=landr_bus if isinstance(landr_bus, str) and landr_bus else None,
            landr_intensity=landr_intensity,
            landr_prefer_vst=True,
        )
        master_wav = str(work / "master.wav")
        sf.write(master_wav, mastered.T, sr, subtype="PCM_24")
        metrics = enforce_safety_limiting(master_wav, max_true_peak_dbfs=-0.5)

        update_render_progress(job_id, "upload/complete", 90, "Uploading master")
        encoded = transcode_and_tag(
            source_wav_path=master_wav,
            title=meta.get("title") or f"Hybrid Mix {job_id[:8]}",
            artist=meta.get("artist") or "Hybrid AI Engine",
            album=meta.get("album") or "Hybrid Vocal Mixes",
            bpm=float(meta.get("bpm") or 120.0),
            cover_image_path=meta.get("cover_image_path"),
        )
        r2_keys = {
            "wav": f"renders/{job_id}.wav",
            "mp3": f"renders/{job_id}.mp3",
            "aac": f"renders/{job_id}.m4a",
        }
        upload_file_to_r2_fast(encoded["wav"], r2_keys["wav"], content_type=CONTENT_TYPES["wav"])
        upload_file_to_r2_fast(encoded["mp3"], r2_keys["mp3"], content_type=CONTENT_TYPES["mp3"])
        upload_file_to_r2_fast(encoded["aac"], r2_keys["aac"], content_type=CONTENT_TYPES["aac"])
        urls = {
            "wav": public_url_for_key(r2_keys["wav"]),
            "mp3": public_url_for_key(r2_keys["mp3"]),
            "aac": public_url_for_key(r2_keys["aac"]),
        }
        metrics = validate_and_log_master(
            job_id,
            master_wav,
            r2_key=r2_keys["wav"],
            metrics=metrics,
            urls=urls,
        )
        result = {
            "job_id": job_id,
            "status": "completed",
            "r2_key": r2_keys["wav"],
            "download_url": _presign(r2_keys["wav"]),
            "urls": urls,
            "metrics": metrics,
            "metadata": meta,
        }
        ping_frontend_webhook(
            job_id,
            urls.get("wav") or result["download_url"],
            task_status="SUCCESS",
            webhook_url=hook,
        )
        update_render_progress(job_id, "upload/complete", 100, "Mix complete")
        return result
    except Exception:
        update_render_progress(job_id, "failed", 0, "Mix failed")
        ping_frontend_webhook(job_id, None, task_status="failed", webhook_url=hook)
        raise
    finally:
        try:
            if os.path.isfile(vocal_path) and str(work) in os.path.abspath(vocal_path):
                os.remove(vocal_path)
        except OSError:
            pass
