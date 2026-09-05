import hmac
import os
import uuid
from typing import List, Optional

from celery.result import AsyncResult
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from hybrid_tokens import (
    HYBRID_MIX_TOKEN_AMOUNT,
    refund_hybrid_generation_tokens,
    spend_hybrid_tokens,
)
from matchmaker import generate_headless_recipe
from models import create_job, get_job, init_db, update_job_status
from tasks import (
    celery_app,
    dispatch_webhook,
    hybrid_vocal_mix_task,
    render_audio_task,
    scratch_dir,
)
from user_track import generate_user_lyrics, master_user_sum, sum_user_stems, usable_webhook_url
from websocket_stream import manager

app = FastAPI(title="Distributed Audio Engine API", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


@app.on_event("startup")
def startup_event():
    init_db()


@app.get("/health")
def health():
    return {"status": "ok"}


class StemLayer(BaseModel):
    track_id: str
    stem: str
    src_bpm: Optional[float] = 120.0
    source_key: Optional[str] = None
    pitch_shift: Optional[int] = 0
    gain_db: Optional[float] = 0.0


class RenderMetadata(BaseModel):
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    cover_image_path: Optional[str] = None


class RenderRequest(BaseModel):
    target_bpm: float
    layers: List[StemLayer]
    metadata: Optional[RenderMetadata] = None
    webhook_url: Optional[str] = None


class AutoGenerateRequest(BaseModel):
    target_bpm: float = 120.0
    target_key: str = "C Major"
    metadata: Optional[RenderMetadata] = None
    webhook_url: Optional[str] = None


class LocalStemRenderRequest(BaseModel):
    vocal_path: str
    drums_path: Optional[str] = None
    bass_path: Optional[str] = None
    other_path: Optional[str] = None
    lyric_prompt: Optional[str] = None
    webhook_url: Optional[str] = None


class UserTrackRequest(BaseModel):
    lyric_prompt: str
    stem_paths: Optional[dict] = None
    vocal_path: Optional[str] = None
    drums_path: Optional[str] = None
    bass_path: Optional[str] = None
    other_path: Optional[str] = None
    webhook_url: Optional[str] = None


class BroadcastProgressRequest(BaseModel):
    job_id: str
    step: str
    progress: float
    message: str = ""


def _authorize_internal_broadcast(request: Request) -> None:
    """Allow loopback, or a matching X-Internal-Token when configured.

    Requests that arrived through a reverse proxy (X-Forwarded-For / X-Real-IP)
    are not treated as loopback, so an unauthenticated public path cannot
    fan out progress just because uvicorn is bound to 127.0.0.1.
    """
    token = (os.environ.get("INTERNAL_BROADCAST_TOKEN") or "").strip()
    provided = (request.headers.get("x-internal-token") or "").strip()
    try:
        token_ok = bool(token) and bool(provided) and hmac.compare_digest(token, provided)
    except (TypeError, ValueError):
        token_ok = False
    if token_ok:
        return
    host = (request.client.host if request.client else "") or ""
    proxied = bool(request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip"))
    if host.strip("[]").lower() in _LOOPBACK_HOSTS and not proxied:
        return
    raise HTTPException(status_code=403, detail="Forbidden")


def _enqueue(job_id: str, layers: list, target_bpm: float, payload, target_key: str | None = None) -> None:
    kwargs = {}
    if payload.metadata is not None:
        kwargs["metadata"] = payload.metadata.model_dump()
    if payload.webhook_url is not None:
        kwargs["webhook_url"] = str(payload.webhook_url)
    if target_key:
        kwargs["target_key"] = target_key
    render_audio_task.apply_async(
        args=[job_id, layers, target_bpm],
        kwargs=kwargs,
        task_id=job_id,
    )


@app.post("/api/v2/render")
def enqueue_render(payload: RenderRequest):
    if not payload.layers:
        raise HTTPException(status_code=400, detail="At least one stem layer is required.")

    job_id = str(uuid.uuid4())
    layers_data = [layer.model_dump() for layer in payload.layers]
    _enqueue(job_id, layers_data, payload.target_bpm, payload)
    return {"job_id": job_id, "status": "queued"}


@app.post("/api/v2/auto-generate")
def auto_generate_and_render(payload: AutoGenerateRequest):
    try:
        recipe = generate_headless_recipe(payload.target_bpm, payload.target_key)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = str(uuid.uuid4())
    _enqueue(
        job_id,
        recipe["layers"],
        recipe["target_bpm"],
        payload,
        target_key=recipe.get("target_key") or payload.target_key,
    )
    return {"job_id": job_id, "status": "queued", "recipe": recipe}


def _collect_stem_paths(
    vocal_path: str | None,
    drums_path: str | None,
    bass_path: str | None,
    other_path: str | None,
    stem_paths: dict | None = None,
) -> dict:
    collected = {
        "vocals": vocal_path,
        "drums": drums_path,
        "bass": bass_path,
        "other": other_path,
    }
    if isinstance(stem_paths, dict):
        for key, path in stem_paths.items():
            if key and path:
                collected[str(key)] = str(path)
    return {key: path for key, path in collected.items() if path}


def _require_existing_stems(stem_paths: dict) -> None:
    existing = [path for path in stem_paths.values() if path and os.path.exists(path)]
    if not existing:
        raise HTTPException(
            status_code=400,
            detail="At least one existing stem path is required.",
        )


def _local_job_payload(job_id: str) -> dict:
    row = get_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")
    status = row.get("status")
    payload = {
        "job_id": row.get("job_id") or job_id,
        "status": status,
        "master_path": row.get("master_url"),
        "lyrics": row.get("lyrics") or "",
    }
    if status == "completed" and payload["lyrics"]:
        payload["message"] = (
            "Lyrics are returned as text and are not mixed into the master."
        )
    return payload


async def run_local_pipeline(
    job_id: str,
    vocal_path: str | None,
    drums_path: str | None,
    bass_path: str | None,
    other_path: str | None,
    lyric_prompt: str | None = None,
    webhook_url: str | None = None,
    extra_stem_paths: dict | None = None,
) -> None:
    work = scratch_dir() / job_id
    work.mkdir(parents=True, exist_ok=True)
    stem_paths = _collect_stem_paths(
        vocal_path, drums_path, bass_path, other_path, extra_stem_paths
    )
    hook = usable_webhook_url(webhook_url)
    lyrics = ""
    try:
        prompt = (lyric_prompt or "").strip()
        if prompt:
            await manager.broadcast_progress(
                job_id,
                "lyrics",
                10,
                "Generating studio lyrics (text only; not mixed into audio).",
            )
            lyrics = generate_user_lyrics(prompt)
        await manager.broadcast_progress(job_id, "summing", 25, "Summing and aligning stems...")
        pre_master_path = str(work / f"{job_id}_pre.wav")
        final_master_path = str(work / f"{job_id}_final.wav")
        sum_user_stems(stem_paths, pre_master_path)
        await manager.broadcast_progress(
            job_id, "mastering", 75, "Applying Pedalboard mastering chain (-14 LUFS)..."
        )
        master_user_sum(pre_master_path, final_master_path)
        lyrics_path = work / f"{job_id}_lyrics.txt"
        lyrics_path.write_text(lyrics, encoding="utf-8")
        update_job_status(job_id, "completed", final_master_path, lyrics=lyrics)
        await manager.broadcast_progress(
            job_id,
            "complete",
            100,
            "Master complete and ready.",
            master_path=final_master_path,
            lyrics=lyrics,
        )
        dispatch_webhook(
            hook,
            {
                "job_id": job_id,
                "status": "completed",
                "master_path": final_master_path,
                "lyrics": lyrics,
            },
        )
    except Exception as exc:
        update_job_status(job_id, "failed")
        await manager.broadcast_progress(job_id, "error", 100, f"Render failed: {exc}")
        dispatch_webhook(
            hook,
            {"job_id": job_id, "status": "failed", "error": str(exc)},
        )


@app.post("/api/render")
def trigger_local_render(request: LocalStemRenderRequest, background_tasks: BackgroundTasks):
    if not request.vocal_path:
        raise HTTPException(status_code=400, detail="vocal_path is required.")
    job_id = str(uuid.uuid4())
    create_job(job_id=job_id, vocal_path=request.vocal_path, instrumental_path="multi_stem_bundle")
    background_tasks.add_task(
        run_local_pipeline,
        job_id,
        request.vocal_path,
        request.drums_path,
        request.bass_path,
        request.other_path,
        request.lyric_prompt,
        request.webhook_url,
    )
    return {
        "status": "success",
        "job_id": job_id,
        "message": "Render pipeline initialized locally.",
    }


@app.get("/api/render/{job_id}")
def local_render_status(job_id: str):
    return _local_job_payload(job_id)


@app.post("/api/v2/user-track")
def enqueue_user_track(request: UserTrackRequest, background_tasks: BackgroundTasks):
    prompt = (request.lyric_prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="lyric_prompt is required.")
    stem_paths = _collect_stem_paths(
        request.vocal_path,
        request.drums_path,
        request.bass_path,
        request.other_path,
        request.stem_paths,
    )
    _require_existing_stems(stem_paths)
    job_id = str(uuid.uuid4())
    vocal = request.vocal_path or next(iter(stem_paths.values()))
    create_job(job_id=job_id, vocal_path=vocal, instrumental_path="multi_stem_bundle")
    background_tasks.add_task(
        run_local_pipeline,
        job_id,
        request.vocal_path,
        request.drums_path,
        request.bass_path,
        request.other_path,
        prompt,
        request.webhook_url,
        request.stem_paths,
    )
    return {
        "status": "queued",
        "job_id": job_id,
        "message": (
            "User-track pipeline started. Lyrics are returned as text and are "
            "not mixed into the master. Watch /ws/render-progress/{job_id} or "
            "GET /api/v2/user-track/{job_id}."
        ),
    }


@app.get("/api/v2/user-track/{job_id}")
def user_track_status(job_id: str):
    return _local_job_payload(job_id)


@app.websocket("/ws/render-progress/{job_id}")
async def websocket_render_progress(websocket: WebSocket, job_id: str):
    await manager.connect(websocket, job_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, job_id)
    except Exception:
        manager.disconnect(websocket, job_id)


@app.post("/api/internal/broadcast")
async def internal_broadcast(payload: BroadcastProgressRequest, request: Request):
    _authorize_internal_broadcast(request)
    await manager.broadcast_progress(
        payload.job_id,
        payload.step,
        payload.progress,
        payload.message,
    )
    return {"ok": True}


@app.get("/api/v2/render/{job_id}")
def check_job_status(job_id: str):
    res = AsyncResult(job_id, app=celery_app)

    if res.state == "PENDING":
        return {"job_id": job_id, "status": "queued"}
    if res.state == "STARTED":
        return {"job_id": job_id, "status": "processing"}
    if res.state == "SUCCESS":
        return res.result
    if res.state == "FAILURE":
        return {"job_id": job_id, "status": "failed", "error": str(res.result)}

    return {"job_id": job_id, "status": res.state}


@app.post("/api/v2/hybrid-mix")
async def hybrid_mix(
    user_id: str = Form(...),
    instrumental_job_id: str = Form(...),
    vocal_file: UploadFile = File(...),
):
    """Deduct Hybrid Tokens first, then save the vocal and enqueue the mix."""
    hybrid_job_id = str(uuid.uuid4())
    spend_key = f"hybrid-mix:{hybrid_job_id}"
    refund_key = f"hybrid-mix-refund:{hybrid_job_id}"
    try:
        spent = spend_hybrid_tokens(
            user_id,
            amount=HYBRID_MIX_TOKEN_AMOUNT,
            note=f"Hybrid vocal mix {hybrid_job_id}",
            idempotency_key=spend_key,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Token spend failed: {exc}") from exc

    if not spent.get("ok"):
        raise HTTPException(
            status_code=402,
            detail={
                "error": spent.get("reason") or "Not enough Hybrid Tokens.",
                "remaining_balance": spent.get("balance", 0),
            },
        )

    vocal_path = None
    try:
        suffix = os.path.splitext(vocal_file.filename or "vocal.wav")[1] or ".wav"
        vocal_path = scratch_dir() / hybrid_job_id
        vocal_path.mkdir(parents=True, exist_ok=True)
        dest = vocal_path / f"user_vocal{suffix}"
        dest.write_bytes(await vocal_file.read())
        task = hybrid_vocal_mix_task.apply_async(
            args=[hybrid_job_id, instrumental_job_id, str(dest)],
            task_id=hybrid_job_id,
        )
    except Exception as exc:
        if not spent.get("bypassed") and not spent.get("already_applied"):
            try:
                refund_hybrid_generation_tokens(
                    user_id,
                    amount=HYBRID_MIX_TOKEN_AMOUNT,
                    note=f"Refund hybrid mix enqueue failure {hybrid_job_id}",
                    idempotency_key=refund_key,
                )
            except Exception as refund_exc:
                print(f"[hybrid-mix] refund failed: {refund_exc}")
        raise HTTPException(status_code=500, detail=f"Failed to queue hybrid mix: {exc}") from exc

    return {
        "hybrid_job_id": hybrid_job_id,
        "task_id": task.id,
        "status": "queued",
        "remaining_balance": spent.get("balance"),
        "tokens_spent": 0 if spent.get("bypassed") else HYBRID_MIX_TOKEN_AMOUNT,
    }


if __name__ == "__main__":
    import uvicorn

    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ.setdefault("HYBRID_INFER_DEVICE", "cpu")
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False, workers=2)
