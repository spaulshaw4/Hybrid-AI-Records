"""Download CC0 Freesound speech previews into ``raw\\freesound_cc0_speech``.

Run::

    python "D:\\MusicDatasets\\download_cc0_speech_packs.py"

Re-running skips files already on disk. Pack sounds are named
``pack_<id>_vocal_<sound_id>_<slug>.mp3``; unpackaged sounds are
``fs_<id>_vocal_<slug>.mp3``.

Honesty
-------
These are Freesound ``preview-hq-mp3`` files: lossy ~128 kbps MP3 **previews**,
not 24-bit originals and not pristine stems. Original-quality download on
Freesound usually needs OAuth2 (``Authorization: Bearer``). Token auth is
enough for search + previews only.

Auth
----
Reads ``FREESOUND_API_KEY`` (or ``FREESOUND_TOKEN``) from the process
environment first, then from the Hybrid AI Forge ``.env``, then from
``D:\\MusicDatasets\\.env`` if present. Apply at
https://freesound.org/apiv2/apply/

This file must never contain a real key. Never commit secrets.

The live slicing campaign under ``D:\\MusicDatasets`` is not pointed at this
folder. After the download finishes::

    D:\\MusicDatasets\\scripts\\run_slicing_campaign.ps1 -Execute -Root "D:\\MusicDatasets\\raw\\freesound_cc0_speech"
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


def configure_stdio() -> None:
    """Keep print() from crashing the job on Windows cp1252 consoles."""
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError, AttributeError):
            pass


def ascii_safe(text: object) -> str:
    return str(text).encode("ascii", errors="replace").decode("ascii")


configure_stdio()

try:
    import requests
except ImportError:
    print(
        "Missing dependency: requests\n"
        "Install with:\n"
        r'  C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe -m pip install requests',
        file=sys.stderr,
    )
    sys.exit(1)

APPLY_URL = "https://freesound.org/apiv2/apply/"
SEARCH_URL = "https://freesound.org/apiv2/search/text/"
SAVE_DIR = r"D:\MusicDatasets\raw\freesound_cc0_speech"
LOG_DIR = r"D:\MusicDatasets\logs"
TARGET = 15_000
PAGE_SIZE = 150
PAGE_SLEEP_SEC = 0.2
FILE_SLEEP_SEC = 0.05
REQUEST_TIMEOUT = (15, 60)
USER_AGENT = "HybridAIForge-cc0-speech-downloader/1.0 (research; preview-hq-mp3 only)"
SEARCH_FILTER = 'license:"Creative Commons 0" category:Speech'
SEARCH_FIELDS = "id,name,previews,pack,license,type,username,duration,category"
MIN_BYTES = 2048
FILENAME_TAG = "vocal"  # pack_<id>_vocal_... or fs_<id>_vocal_...
KEY_NAMES = ("FREESOUND_API_KEY", "FREESOUND_TOKEN")
REPO_ENV_PATH = Path(r"C:\Users\spaul\Downloads\Hybrid AI Forge (10)\.env")
DATASETS_ENV_PATH = Path(r"D:\MusicDatasets\.env")


def is_real_key(value: str | None) -> bool:
    if not value:
        return False
    text = value.strip().strip("\"'")
    if len(text) < 20:
        return False
    upper = text.upper()
    if any(marker in upper for marker in ("PASTE_YOUR", "YOUR_API_KEY", "YOUR_TOKEN", "CHANGEME")):
        return False
    return True


def parse_dotenv(path: Path) -> dict[str, str]:
    """Parse KEY=value lines. Skip comments. Never log or write values."""
    parsed: dict[str, str] = {}
    if not path.is_file():
        return parsed
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return parsed
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            parsed[key] = value
    return parsed


def resolve_api_key() -> str:
    """Process env first, then repo .env, then D:\\MusicDatasets\\.env."""
    for name in KEY_NAMES:
        candidate = os.environ.get(name, "")
        if is_real_key(candidate):
            return candidate.strip().strip("\"'")
    for env_path in (REPO_ENV_PATH, DATASETS_ENV_PATH):
        values = parse_dotenv(env_path)
        for name in KEY_NAMES:
            candidate = values.get(name, "")
            if is_real_key(candidate):
                return candidate.strip().strip("\"'")
    return ""


def missing_key_message() -> str:
    return (
        "FREESOUND_API_KEY is not set (FREESOUND_TOKEN also accepted).\n"
        "Set the variable in the process environment, or add it to:\n"
        f"  {REPO_ENV_PATH}\n"
        f"  {DATASETS_ENV_PATH}\n"
        f"Get a token at {APPLY_URL}\n"
        "No files were downloaded."
    )


def auth_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Token {api_key}",
        "User-Agent": USER_AGENT,
    }


def slugify(name: str) -> str:
    base = os.path.splitext(str(name or "sound"))[0]
    cleaned = re.sub(r"[^\w\s-]+", "", base, flags=re.UNICODE)
    cleaned = re.sub(r"[-\s]+", "_", cleaned).strip("_")
    return (cleaned or "sound")[:72]


def pack_id_from_sound(sound: dict[str, Any]) -> str | None:
    pack = sound.get("pack")
    if pack in (None, "", 0):
        return None
    if isinstance(pack, int):
        return str(pack)
    text = str(pack)
    match = re.search(r"/packs/(\d+)/?", text)
    if match:
        return match.group(1)
    if text.isdigit():
        return text
    return None


def dest_path(save_dir: Path, sound: dict[str, Any]) -> Path:
    sound_id = sound.get("id")
    slug = slugify(str(sound.get("name") or "sound"))
    tag = f"_{FILENAME_TAG}" if FILENAME_TAG else ""
    pack_id = pack_id_from_sound(sound)
    if pack_id:
        folder = save_dir / f"pack_{pack_id}{tag}"
        filename = f"pack_{pack_id}{tag}_{sound_id}_{slug}.mp3"
    else:
        folder = save_dir / "unpacked"
        filename = f"fs_{sound_id}{tag}_{slug}.mp3"
    return folder / filename


def preview_url(sound: dict[str, Any]) -> str:
    previews = sound.get("previews") or {}
    if not isinstance(previews, dict):
        return ""
    for key in ("preview-hq-mp3", "preview-lq-mp3", "preview-hq-ogg"):
        url = previews.get(key) or ""
        if url:
            return str(url)
    return ""


def retry_wait_seconds(response: requests.Response, attempt: int) -> float:
    raw = response.headers.get("Retry-After")
    if raw:
        try:
            return max(1.0, float(raw))
        except ValueError:
            pass
    return min(120.0, 8.0 * (2 ** attempt))


def request_json(
    session: requests.Session,
    url: str,
    *,
    headers: dict[str, str],
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    last_error = "request failed"
    for attempt in range(8):
        try:
            response = session.get(
                url, headers=headers, params=params, timeout=REQUEST_TIMEOUT
            )
        except requests.RequestException as exc:
            last_error = str(exc)
            time.sleep(min(30.0, 2.0 * (attempt + 1)))
            continue
        if response.status_code == 429:
            wait = retry_wait_seconds(response, attempt)
            print(f"[429] rate limited, sleeping {wait:.1f}s", flush=True)
            time.sleep(wait)
            continue
        if response.status_code in (500, 502, 503, 504):
            wait = min(30.0, 2.0 * (attempt + 1))
            print(f"[{response.status_code}] server error, retry in {wait:.1f}s", flush=True)
            time.sleep(wait)
            continue
        if response.status_code in (401, 403):
            raise SystemExit(
                f"Freesound rejected the API token (HTTP {response.status_code}). "
                f"Get a new key at {APPLY_URL}"
            )
        try:
            response.raise_for_status()
            payload = response.json()
        except (ValueError, requests.RequestException) as exc:
            last_error = str(exc)
            time.sleep(min(15.0, 2.0 * (attempt + 1)))
            continue
        if not isinstance(payload, dict):
            last_error = "unexpected JSON payload"
            continue
        return payload
    raise RuntimeError(f"Freesound API failed after retries: {last_error}")


def download_preview(
    session: requests.Session,
    url: str,
    dest: Path,
    *,
    headers: dict[str, str],
) -> str:
    """Write ``dest`` atomically. Returns 'saved', 'skipped', or raises."""
    if dest.is_file() and dest.stat().st_size >= MIN_BYTES:
        return "skipped"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last_error = "download failed"
    for attempt in range(6):
        try:
            with session.get(
                url, headers=headers, timeout=REQUEST_TIMEOUT, stream=True
            ) as response:
                if response.status_code == 429:
                    wait = retry_wait_seconds(response, attempt)
                    print(f"[429] preview rate limited, sleeping {wait:.1f}s", flush=True)
                    time.sleep(wait)
                    continue
                response.raise_for_status()
                with open(tmp, "wb") as handle:
                    for chunk in response.iter_content(chunk_size=64 * 1024):
                        if chunk:
                            handle.write(chunk)
            size = tmp.stat().st_size if tmp.is_file() else 0
            if size < MIN_BYTES:
                last_error = f"preview too small ({size} bytes)"
                try:
                    tmp.unlink()
                except OSError:
                    pass
                time.sleep(1.0)
                continue
            os.replace(tmp, dest)
            return "saved"
        except requests.RequestException as exc:
            last_error = str(exc)
            if tmp.is_file() and not dest.is_file():
                try:
                    tmp.unlink()
                except OSError:
                    pass
            time.sleep(min(20.0, 2.0 * (attempt + 1)))
    raise RuntimeError(last_error)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Download Freesound CC0 Speech category preview-hq-mp3 files. "
            "Lossy previews, not 24-bit originals. Default is execute up to "
            f"{TARGET} files; re-run to resume."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Search and print the plan only; do not write audio.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help=f"Max files to save this run (0 = {TARGET}).",
    )
    parser.add_argument(
        "--save-dir",
        default=SAVE_DIR,
        help="Destination root (default: D:\\MusicDatasets\\raw\\freesound_cc0_speech).",
    )
    return parser


def target_for_limit(limit: int) -> int:
    if limit and limit > 0:
        return int(limit)
    return TARGET


def run(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    api_key = resolve_api_key()
    if not api_key:
        print(missing_key_message(), file=sys.stderr)
        return 2

    save_dir = Path(args.save_dir)
    target = target_for_limit(args.limit)
    dry_run = bool(args.dry_run)
    headers = auth_headers(api_key)
    save_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 72, flush=True)
    print("Freesound CC0 Speech pack downloader", flush=True)
    print(
        "Honesty: preview-hq-mp3 is a lossy ~128 kbps preview, not a 24-bit original.",
        flush=True,
    )
    print(f"save_dir={save_dir}", flush=True)
    print(f"filter={SEARCH_FILTER}", flush=True)
    print(f"target={target}  dry_run={dry_run}  resume=skip existing", flush=True)
    print("=" * 72, flush=True)

    params: dict[str, Any] = {
        "query": "",
        "filter": SEARCH_FILTER,
        "fields": SEARCH_FIELDS,
        "page_size": PAGE_SIZE,
        "sort": "downloads_desc",
        "page": 1,
    }

    saved = 0
    skipped = 0
    failed = 0
    page = 0
    considered = 0
    next_url: str | None = SEARCH_URL
    next_params: dict[str, Any] | None = params

    with requests.Session() as session:
        session.headers.update({"User-Agent": USER_AGENT})
        while next_url and (saved + skipped) < target:
            page += 1
            payload = request_json(
                session, next_url, headers=headers, params=next_params
            )
            results = payload.get("results") or []
            count = payload.get("count")
            if page == 1:
                print(f"Freesound reports count={count} matching CC0 Speech sounds.", flush=True)
                if not results:
                    print(
                        "[warn] category:Speech returned 0 results; "
                        'retrying filter license:"Creative Commons 0" tag:speech',
                        flush=True,
                    )
                    params["filter"] = 'license:"Creative Commons 0" tag:speech'
                    next_url = SEARCH_URL
                    next_params = params
                    page = 0
                    continue
            print(
                f"[page {page}] results={len(results)}  "
                f"saved={saved} skipped={skipped} failed={failed}",
                flush=True,
            )
            for sound in results:
                if (saved + skipped) >= target:
                    break
                if not isinstance(sound, dict):
                    continue
                considered += 1
                url = preview_url(sound)
                dest = dest_path(save_dir, sound)
                if not url:
                    failed += 1
                    print(f"  [skip-no-preview] id={sound.get('id')}", flush=True)
                    continue
                if dry_run:
                    status = "skipped" if dest.is_file() else "would-save"
                    print(f"  [{status}] {ascii_safe(dest.name)}", flush=True)
                    if status == "skipped":
                        skipped += 1
                    else:
                        saved += 1
                    continue
                try:
                    status = download_preview(session, url, dest, headers=headers)
                except Exception as exc:
                    failed += 1
                    print(f"  [failed] {ascii_safe(dest.name)}: {ascii_safe(exc)}", flush=True)
                    continue
                if status == "saved":
                    saved += 1
                    print(f"  [saved] {ascii_safe(dest.relative_to(save_dir))}", flush=True)
                else:
                    skipped += 1
                time.sleep(FILE_SLEEP_SEC)

            next_link = payload.get("next")
            if not next_link or (saved + skipped) >= target:
                break
            next_url = str(next_link)
            next_params = None
            time.sleep(PAGE_SLEEP_SEC)

    print("-" * 72, flush=True)
    print(
        f"Done. saved={saved} skipped={skipped} failed={failed} "
        f"considered={considered} target={target} dry_run={dry_run}",
        flush=True,
    )
    print(
        "These files are Freesound preview-hq-mp3 (lossy), not 24-bit stems.",
        flush=True,
    )
    if not dry_run:
        print("Resume: re-run the same command; existing files are skipped.", flush=True)
        print(
            "After download finishes, slice this folder only (do not retarget "
            "the live campaign mid-flight):",
            flush=True,
        )
        print(
            r'  D:\MusicDatasets\scripts\run_slicing_campaign.ps1 -Execute '
            r'-Root "D:\MusicDatasets\raw\freesound_cc0_speech"',
            flush=True,
        )
    return 0 if failed == 0 or saved > 0 or skipped > 0 else 1


if __name__ == "__main__":
    sys.exit(run())
