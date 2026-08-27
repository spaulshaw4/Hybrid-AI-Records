#!/usr/bin/env python3
"""Multipart Cloudflare R2 uploads with a shared boto3 client."""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config

MULTIPART_BYTES = 8 * 1024 * 1024
TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=MULTIPART_BYTES,
    max_concurrency=10,
    multipart_chunksize=MULTIPART_BYTES,
    use_threads=True,
)


def _load_env() -> None:
    root = Path(__file__).resolve().parent
    for name in (".env.local", ".env"):
        path = root / name
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


_load_env()

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "").strip()
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME", "music-engine-stems").strip()
R2_PUBLIC_DOMAIN = os.environ.get("R2_PUBLIC_DOMAIN", "").strip().rstrip("/")
R2_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL", "").strip() or (
    f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com" if R2_ACCOUNT_ID else ""
)

s3_client = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT_URL or None,
    aws_access_key_id=R2_ACCESS_KEY_ID or None,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY or None,
    config=Config(
        signature_version="s3v4",
        retries={"max_attempts": 5, "mode": "adaptive"},
        max_pool_connections=25,
    ),
)


def public_url_for_key(r2_key: str) -> str | None:
    if not R2_PUBLIC_DOMAIN:
        return None
    return f"{R2_PUBLIC_DOMAIN}/{r2_key.lstrip('/')}"


def upload_file_to_r2_fast(
    local_path: str,
    r2_key: str,
    content_type: str = "audio/wav",
) -> None:
    extra = {}
    if content_type:
        extra["ContentType"] = content_type
    kwargs = {"Config": TRANSFER_CONFIG}
    if extra:
        kwargs["ExtraArgs"] = extra
    s3_client.upload_file(local_path, R2_BUCKET_NAME, r2_key, **kwargs)
    print(f"Uploaded {local_path} -> {r2_key}")


def _stem_object_name(stem_name: str) -> str:
    name = Path(stem_name).name
    if not name.lower().endswith(".wav"):
        name = f"{name}.wav"
    return name


def upload_stems_parallel(stems_dict: dict, track_id: str) -> list[str]:
    """Upload already-separated stems. I/O only — do not call this around Demucs."""

    def _one(stem_name: str, local_path: str) -> str:
        key = f"stems/{track_id}/{_stem_object_name(stem_name)}"
        upload_file_to_r2_fast(local_path, key, content_type="audio/wav")
        return key

    uploaded: list[str] = []
    items = [(name, path) for name, path in stems_dict.items() if path and os.path.isfile(path)]
    if not items:
        return uploaded

    workers = min(4, len(items))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_one, name, path) for name, path in items]
        for fut in as_completed(futures):
            uploaded.append(fut.result())
    return uploaded
