#!/usr/bin/env python3
"""Queue a 5-track EP via POST /api/v2/auto-generate and poll until each mix is in R2.

  python scripts/batch_generate_ep.py
  API_BASE_URL=https://dmlllpvfenxzw7-8000.proxy.runpod.net python scripts/batch_generate_ep.py
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]


def _load_env() -> None:
    for name in (".env.local", ".env"):
        path = ROOT / name
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

API_BASE_URL = (os.environ.get("API_BASE_URL") or "http://localhost:8000").rstrip("/")
EP_STRUCTURE = [
    {"track_no": 1, "bpm": 120.0, "key": "A Minor"},
    {"track_no": 2, "bpm": 122.0, "key": "D Minor"},
    {"track_no": 3, "bpm": 124.0, "key": "G Minor"},
    {"track_no": 4, "bpm": 126.0, "key": "C Minor"},
    {"track_no": 5, "bpm": 128.0, "key": "F Minor"},
]


def poll_job_completion(job_id: str, max_retries: int = 60, delay: int = 5) -> dict:
    url = f"{API_BASE_URL}/api/v2/render/{job_id}"
    for _ in range(max_retries):
        res = requests.get(url, timeout=30)
        res.raise_for_status()
        payload = res.json()
        status = str(payload.get("status") or "")
        if status.lower() in {"completed", "success"}:
            return payload
        if status.lower() in {"failed", "failure"}:
            raise RuntimeError(f"Render job {job_id} failed: {payload.get('error')}")
        time.sleep(delay)
    raise TimeoutError(f"Job {job_id} timed out while processing.")


def build_ep() -> None:
    manifest = []
    print(f"Starting automated {len(EP_STRUCTURE)}-track EP generation against {API_BASE_URL}...")
    for track_spec in EP_STRUCTURE:
        print(
            f"\n[Track {track_spec['track_no']}] Requesting mix at "
            f"{track_spec['bpm']} BPM ({track_spec['key']})..."
        )
        res = requests.post(
            f"{API_BASE_URL}/api/v2/auto-generate",
            json={"target_bpm": track_spec["bpm"], "target_key": track_spec["key"]},
            timeout=60,
        )
        if res.status_code != 200:
            print(f"Failed to queue track {track_spec['track_no']}: {res.text}")
            continue

        data = res.json()
        job_id = data["job_id"]
        print(f"Enqueued Job ID: {job_id}")
        result = poll_job_completion(job_id)
        r2_key = result.get("r2_key")
        print(f"Mastered & uploaded: {r2_key}")
        manifest.append(
            {
                "track_no": track_spec["track_no"],
                "bpm": track_spec["bpm"],
                "key": track_spec["key"],
                "r2_key": r2_key,
                "download_url": result.get("download_url"),
                "urls": result.get("urls"),
                "metrics": result.get("metrics"),
                "recipe": data.get("recipe"),
            }
        )

    output_manifest_path = ROOT / "generated_ep_manifest.json"
    output_manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nEP generation complete. Manifest written to {output_manifest_path}")


if __name__ == "__main__":
    build_ep()
