"""End-to-end smoke test against the running live API (default 127.0.0.1:8880).

    python scripts/smoke_test_live_pipeline.py
    python scripts/smoke_test_live_pipeline.py --bars 32 --bpm 124 --timeout 180

1. POST /api/tracks/create with a 32-bar request (``bars`` + ``bpm``).
2. Poll GET /api/jobs/{session_id} until the job leaves queued/running, or
   fail cleanly after ``--timeout`` seconds.
3. Require ``status == delivery_status == "completed"`` and no
   ``delivery_error``.
4. GET every returned URL:
   * ``manifest_url`` - JSON with ``song_plan``, loudness, and a provenance
     block that either compared references or states why not;
   * ``master_url`` - integrated loudness -14.0 LUFS +-0.5, true peak
     <= -1.0 dBTP (4x oversampled, BS.1770 style);
   * ``zip_url`` - HTTP 200, ``application/zip``, valid archive containing
     master, manifest, and stems;
   * ``stem_urls`` - every stem returns a RIFF/WAVE header (no 404s).

Exits 0 when every check passes, 1 otherwise. Honors HYBRID_WORKER_TOKEN.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from typing import Any

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

TARGET_LUFS = -14.0
LUFS_TOLERANCE = 0.5
CEILING_DBTP = -1.0
# 24-bit PCM rounding can land a hair above an exact -1.000 dBTP ceiling.
DBTP_EPSILON = 0.01
EXPECTED_STEMS = (
    "drums.wav",
    "bass.wav",
    "rhythm_guitar.wav",
    "lead_guitar.wav",
    "synth.wav",
    "vocals.wav",
)


@dataclass
class Report:
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append((name, bool(ok), detail))
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}{': ' + detail if detail else ''}", flush=True)
        return bool(ok)

    @property
    def ok(self) -> bool:
        return all(ok for _n, ok, _d in self.checks)


class Api:
    def __init__(self, base: str, timeout: float = 30.0) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout
        token = (os.environ.get("HYBRID_WORKER_TOKEN") or "").strip()
        self.headers = {"x-hybrid-worker-token": token} if token else {}

    def url(self, path: str) -> str:
        return path if path.startswith("http") else f"{self.base}{path}"

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        merged = {**self.headers, **(headers or {})}
        if data is not None:
            merged["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url(path), data=data, method=method, headers=merged)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, {k.lower(): v for k, v in exc.headers.items()}, exc.read()

    def json(self, path: str, **kwargs: Any) -> tuple[int, Any]:
        status, _headers, payload = self.request(path, **kwargs)
        try:
            return status, json.loads(payload.decode("utf-8") or "null")
        except (UnicodeDecodeError, json.JSONDecodeError):
            return status, None


def create_job(api: Api, report: Report, args: argparse.Namespace) -> str | None:
    body = {
        "prompt": args.prompt,
        "genre_hint": args.genre,
        "bars": args.bars,
        "bpm": args.bpm,
    }
    status, payload = api.json("/api/tracks/create", method="POST", body=body)
    session_id = (payload or {}).get("session_id") if isinstance(payload, dict) else None
    report.check(
        "create job",
        status == 200 and bool(session_id),
        f"HTTP {status} session={session_id} bars={args.bars} bpm={args.bpm}",
    )
    return session_id


def poll_job(api: Api, report: Report, session_id: str, timeout: float, interval: float) -> dict | None:
    deadline = time.monotonic() + timeout
    started = time.monotonic()
    job: dict | None = None
    last_state = None
    while time.monotonic() < deadline:
        status, payload = api.json(f"/api/jobs/{session_id}")
        if status != 200 or not isinstance(payload, dict):
            report.check("poll job", False, f"HTTP {status}")
            return None
        job = payload
        state = (job.get("status"), job.get("note"))
        if state != last_state:
            print(f"    t+{time.monotonic() - started:5.1f}s status={state[0]} note={state[1]}", flush=True)
            last_state = state
        if job.get("status") not in {"queued", "running"}:
            break
        time.sleep(interval)
    else:
        report.check("job finished", False, f"timed out after {timeout:.0f}s (last status={job and job.get('status')})")
        return None
    elapsed = time.monotonic() - started
    report.check("job finished", True, f"{elapsed:.1f}s status={job.get('status')}")
    return job


def check_job_fields(report: Report, job: dict) -> None:
    report.check("status == completed", job.get("status") == "completed", str(job.get("error") or ""))
    report.check(
        "delivery_status == completed",
        job.get("delivery_status") == "completed",
        f"delivery_status={job.get('delivery_status')!r}",
    )
    report.check("delivery_error is null", job.get("delivery_error") is None, str(job.get("delivery_error") or ""))


def check_manifest(api: Api, report: Report, url: str | None) -> dict | None:
    if not report.check("manifest_url present", bool(url)):
        return None
    status, manifest = api.json(url)
    if not report.check("manifest HTTP 200 + JSON", status == 200 and isinstance(manifest, dict), f"HTTP {status}"):
        return None
    plan = manifest.get("song_plan")
    report.check(
        "manifest.song_plan",
        isinstance(plan, dict) and bool(plan.get("bpm")) and bool(plan.get("sections")),
        f"bpm={plan.get('bpm') if isinstance(plan, dict) else None} "
        f"sections={len(plan.get('sections') or []) if isinstance(plan, dict) else 0}",
    )
    loudness = manifest.get("loudness") or {}
    report.check(
        "manifest.loudness",
        loudness.get("integrated_lufs") is not None and loudness.get("true_peak_dbtp") is not None,
        f"{loudness}",
    )
    provenance = manifest.get("provenance") or {}
    details = provenance.get("details") or {}
    references = int(details.get("references") or 0)
    status_text = details.get("status")
    report.check(
        "manifest.provenance (references > 0 or explicit status)",
        references > 0 or bool(status_text),
        f"references={references} status={status_text!r} certified={provenance.get('certified')}",
    )
    return manifest


def check_master(api: Api, report: Report, url: str | None) -> None:
    if not report.check("master_url present", bool(url)):
        return
    status, headers, payload = api.request(url)
    if not report.check("master HTTP 200", status == 200 and len(payload) > 44, f"HTTP {status} bytes={len(payload)}"):
        return
    import numpy as np
    import pyloudnorm as pyln
    import soundfile as sf

    from dsp.true_peak_limiter import measure_true_peak_dbtp

    audio, sr = sf.read(io.BytesIO(payload), always_2d=True)
    audio = np.asarray(audio, dtype=np.float64)
    lufs = float(pyln.Meter(int(sr)).integrated_loudness(audio))
    dbtp = float(measure_true_peak_dbtp(audio))
    report.check(
        "master loudness -14.0 LUFS +-0.5",
        abs(lufs - TARGET_LUFS) <= LUFS_TOLERANCE,
        f"{lufs:.2f} LUFS ({audio.shape[0] / sr:.1f}s @ {sr} Hz)",
    )
    report.check(
        "master true peak <= -1.0 dBTP",
        dbtp <= CEILING_DBTP + DBTP_EPSILON,
        f"{dbtp:.3f} dBTP",
    )


def check_zip(api: Api, report: Report, url: str | None) -> None:
    if not report.check("zip_url present", bool(url)):
        return
    status, headers, payload = api.request(url)
    content_type = headers.get("content-type", "")
    report.check(
        "zip HTTP 200 + application/zip",
        status == 200 and content_type.startswith("application/zip"),
        f"HTTP {status} content-type={content_type} bytes={len(payload)}",
    )
    report.check("zip magic PK\\x03\\x04", payload[:4] == b"PK\x03\x04")
    with tempfile.TemporaryFile() as handle:
        handle.write(payload)
        handle.seek(0)
        try:
            with zipfile.ZipFile(handle) as archive:
                names = set(archive.namelist())
        except zipfile.BadZipFile as exc:
            report.check("zip archive readable", False, str(exc))
            return
    missing = {"master.wav", "manifest.json"} | {f"stems/{s}" for s in EXPECTED_STEMS}
    missing -= names
    report.check("zip contents", not missing, f"{len(names)} entries; missing={sorted(missing) or 'none'}")


def check_stems(api: Api, report: Report, stem_urls: dict | None) -> None:
    stem_urls = stem_urls or {}
    report.check(
        "stem_urls complete",
        set(stem_urls) == set(EXPECTED_STEMS),
        f"{sorted(stem_urls)}",
    )
    for name, url in sorted(stem_urls.items()):
        status, _headers, payload = api.request(url, headers={"Range": "bytes=0-11"})
        ok = status in {200, 206} and payload[:4] == b"RIFF" and payload[8:12] == b"WAVE"
        report.check(f"stem {name}", ok, f"HTTP {status}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Live pipeline smoke test")
    parser.add_argument("--base-url", default="http://127.0.0.1:8880")
    parser.add_argument("--prompt", default="smoke test: driving alternative rock, E minor")
    parser.add_argument("--genre", default="alternative_rock")
    parser.add_argument("--bars", type=int, default=32)
    parser.add_argument("--bpm", type=float, default=124.0)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--interval", type=float, default=5.0)
    args = parser.parse_args(argv)

    api = Api(args.base_url)
    report = Report()
    status, health = api.json("/health")
    if not report.check("health", status == 200, json.dumps(health) if health else f"HTTP {status}"):
        return 1
    session_id = create_job(api, report, args)
    if not session_id:
        return 1
    job = poll_job(api, report, session_id, args.timeout, args.interval)
    if job is None:
        return 1
    check_job_fields(report, job)
    check_manifest(api, report, job.get("manifest_url"))
    check_master(api, report, job.get("master_url"))
    check_zip(api, report, job.get("zip_url"))
    check_stems(api, report, job.get("stem_urls"))

    failed = [name for name, ok, _d in report.checks if not ok]
    print(
        f"\n[SMOKE] session={session_id} {len(report.checks) - len(failed)}/{len(report.checks)} checks passed"
        + (f"; FAILED: {', '.join(failed)}" if failed else "")
    )
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
