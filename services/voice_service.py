"""Optional vocal render via a pinned public Replicate audio model.

HTTP only (urllib). This repo does not install the ``replicate`` package or
``requests``. Auth is the hybrid ``REPLICATE_API_TOKEN`` (alias
``REPLICATE_API_KEY``). Lyric and Gemini keys are never used.

``meta-innovation/heart_mula`` is a public model, but its Input schema has no
audio/file property, so a saved ``ref_vocal.wav`` cannot be mapped onto it.
``minimax/music-01`` is the pinned replacement: ``voice_file`` is the voice
reference and ``lyrics`` is the lyric text. There is no prompt field.
"""
from __future__ import annotations

import json
import os
import re
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

# Pinned from GET /v1/models/minimax/music-01 ``latest_version.id``.
# Do not call the unversioned "latest" model URL.
VOICE_MODEL = "minimax/music-01"
VOICE_VERSION = "0254c7e2f54315b667dbae03da7c155822ba29ffe0457be5bc246d564be486bd"
# OpenAPI Input names from that same GET. Do not invent others.
VOICE_AUDIO_FIELD = "voice_file"
VOICE_LYRICS_FIELD = "lyrics"
PREDICTIONS_URL = (
    f"https://api.replicate.com/v1/models/{VOICE_MODEL}/versions/{VOICE_VERSION}/predictions"
)
# Cloudflare rejects urllib's default User-Agent with a 403 before Replicate.
_USER_AGENT = "hybrid-voice/1.0"
FILES_URL = "https://api.replicate.com/v1/files"
VOICE_TIMEOUT_SEC = 120.0
VOICE_POLL_SEC = 2.0
MAX_LYRICS_CHARS = 6000
MAX_REFERENCE_BYTES = 25 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
_TERMINAL = frozenset({"succeeded", "failed", "canceled"})
_SESSION_RE = re.compile(r"[A-Za-z0-9_-]+")
_DOWNLOAD_HOSTS = frozenset({"replicate.delivery", "api.replicate.com"})


def _default_scratch_root() -> str:
    explicit = (os.environ.get("HYBRID_SCRATCH") or "").strip()
    if explicit:
        return explicit
    live = (os.environ.get("HYBRID_LIVE_OUTPUT") or r"C:\live_web_outputs").strip()
    return os.path.join(live, "scratch")


SCRATCH_ROOT = _default_scratch_root()


class VoiceInputError(ValueError):
    """Lyrics, reference audio, or session id is unusable. No HTTP has run."""


class MissingToken(RuntimeError):
    """``REPLICATE_API_TOKEN`` is missing. No Replicate request has been made."""


def _is_under(path: str, root: str) -> bool:
    real = os.path.abspath(path)
    base = os.path.abspath(root)
    return real == base or real.startswith(base + os.sep)


def _validate_session_id(session_id: str) -> str:
    session = (session_id or "").strip()
    if (
        not session
        or session in {".", ".."}
        or "/" in session
        or "\\" in session
        or "." in session
        or not _SESSION_RE.fullmatch(session)
    ):
        raise VoiceInputError("invalid session_id")
    return session


def _validate_lyrics(lyrics_or_text: str) -> str:
    text = (lyrics_or_text or "").strip()
    if not text:
        raise VoiceInputError("lyrics are required")
    if len(text) > MAX_LYRICS_CHARS:
        raise VoiceInputError("lyrics are too long")
    return text


def _validate_reference(reference_audio_path: str) -> str:
    if not reference_audio_path or not isinstance(reference_audio_path, str):
        raise VoiceInputError("reference audio is missing")
    path = os.path.abspath(reference_audio_path)
    if not os.path.isfile(path):
        raise VoiceInputError("reference audio is missing")
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            header = handle.read(16)
    except OSError as exc:
        raise VoiceInputError("reference audio is unreadable") from exc
    if size < 64 or not header:
        raise VoiceInputError("reference audio is empty")
    if size > MAX_REFERENCE_BYTES:
        raise VoiceInputError("reference audio is too large")
    return path


def _destination(session: str) -> str:
    root = os.path.abspath(SCRATCH_ROOT)
    session_dir = os.path.abspath(os.path.join(root, session))
    dest = os.path.abspath(os.path.join(session_dir, f"{session}_vocal.wav"))
    if not _is_under(session_dir, root) or not _is_under(dest, root):
        raise VoiceInputError("invalid session_id")
    return dest


def _audio_token() -> str:
    """Hybrid Replicate token only. Never ``LYRIC_ENGINE_API_KEY``.

    A blank token raises ``MissingToken`` before any socket is opened.
    The value itself is never returned to logs.
    """
    from engine.gemini_arranger import _load_env_quiet, replicate_token

    _load_env_quiet()
    token = replicate_token()
    if not token:
        raise MissingToken("REPLICATE_API_TOKEN is not configured")
    return token


def _http_error_text(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read()
    except Exception:
        raw = b""
    text = raw.decode("utf-8", errors="replace").strip().replace("\r", " ").replace("\n", " ")
    return text[:500]


def _voice_json(
    url: str,
    token: str,
    payload: dict | None,
    timeout: float,
    extra_headers: dict[str, str] | None = None,
) -> dict:
    """One urllib JSON call. HTTP errors keep the response body, not the token."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": _USER_AGENT,
        "Authorization": f"Bearer {token}",
    }
    if extra_headers:
        headers.update({str(key): str(value) for key, value in extra_headers.items()})
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if payload is not None else "GET",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = _http_error_text(exc)
        message = f"HTTP {exc.code}"
        if body:
            message = f"{message}: {body}"
        raise RuntimeError(message) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("Replicate request failed") from exc


def _output_url(output: Any) -> str:
    """Replicate output is an audio URL, or a one-item list of one URL."""
    if isinstance(output, str) and output.strip():
        return output.strip()
    if isinstance(output, (list, tuple)) and len(output) == 1:
        item = output[0]
        if isinstance(item, str) and item.strip():
            return item.strip()
    raise RuntimeError("voice output was not an audio URL")


def _content_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".mp3":
        return "audio/mpeg"
    if ext == ".webm":
        return "audio/webm"
    if ext == ".ogg":
        return "audio/ogg"
    return "audio/wav"


def _multipart_file(filename: str, body: bytes, content_type: str) -> tuple[bytes, str]:
    safe_name = os.path.basename(filename).replace('"', "").replace("\r", "").replace("\n", "")
    if not safe_name or safe_name in {".", ".."}:
        safe_name = "reference.wav"
    boundary = "----hybridvoice" + uuid.uuid4().hex
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="content"; filename="{safe_name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return head + body + tail, boundary


def _upload_reference(path: str, token: str, timeout: float) -> str:
    """POST the reference to Replicate's files API. Returns ``urls.get``."""
    with open(path, "rb") as handle:
        raw = handle.read()
    payload, boundary = _multipart_file(os.path.basename(path), raw, _content_type(path))
    req = urllib.request.Request(
        FILES_URL,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            uploaded = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = _http_error_text(exc)
        message = f"Replicate file upload failed: HTTP {exc.code}"
        if body:
            message = f"{message}: {body}"
        raise RuntimeError(message) from exc
    except urllib.error.URLError as exc:
        traceback.print_exc()
        raise RuntimeError("Replicate file upload failed") from exc
    urls = uploaded.get("urls") if isinstance(uploaded.get("urls"), dict) else {}
    file_url = str((urls or {}).get("get") or "").strip()
    if not file_url:
        raise RuntimeError("Replicate file upload did not return a URL")
    return file_url


def _run_prediction(
    token: str,
    audio_url: str,
    text: str,
    deadline: float,
    prompt: str | None = None,
) -> dict:
    """Create a pinned-version prediction and poll ``urls.get`` until it finishes.

    ``prompt`` is accepted by the caller and not sent: this model's Input
    schema has no prompt, tags, or style property.
    """
    _ = prompt

    def remaining() -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("voice processing timed out")
        return left

    model_input = {
        VOICE_AUDIO_FIELD: audio_url,
        VOICE_LYRICS_FIELD: text,
    }
    prediction = _voice_json(
        PREDICTIONS_URL,
        token,
        {"input": model_input},
        timeout=min(70.0, remaining()),
        extra_headers={"Prefer": "wait"},
    )
    while str(prediction.get("status") or "") not in _TERMINAL:
        if time.monotonic() >= deadline:
            raise TimeoutError("voice processing timed out")
        urls = prediction.get("urls") if isinstance(prediction.get("urls"), dict) else {}
        poll_url = str((urls or {}).get("get") or "").strip()
        if not poll_url:
            raise RuntimeError("voice prediction has no urls.get")
        delay = min(VOICE_POLL_SEC, max(0.0, deadline - time.monotonic()))
        if delay <= 0:
            raise TimeoutError("voice processing timed out")
        time.sleep(delay)
        if time.monotonic() >= deadline:
            raise TimeoutError("voice processing timed out")
        prediction = _voice_json(poll_url, token, None, timeout=min(60.0, remaining()))
    status = str(prediction.get("status") or "")
    if status != "succeeded":
        detail = str(prediction.get("error") or status or "failed")[:240]
        raise RuntimeError(f"voice prediction {status or 'failed'}: {detail}")
    return prediction


def _download_output(url: str, timeout: float) -> bytes:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in _DOWNLOAD_HOSTS:
        raise RuntimeError("voice output URL was not accepted")
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            chunks: list[bytes] = []
            total = 0
            while True:
                block = resp.read(65536)
                if not block:
                    break
                total += len(block)
                if total > MAX_DOWNLOAD_BYTES:
                    raise RuntimeError("voice audio download was too large")
                chunks.append(block)
    except urllib.error.HTTPError as exc:
        traceback.print_exc()
        raise RuntimeError(f"voice audio download failed: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        traceback.print_exc()
        raise RuntimeError("voice audio download failed") from exc
    body = b"".join(chunks)
    if not body:
        raise RuntimeError("voice audio download was empty")
    return body


def _write_vocal(dest: str, body: bytes, *, scratch_root: str | None = None) -> None:
    root = os.path.abspath(scratch_root or SCRATCH_ROOT)
    dest_abs = os.path.abspath(dest)
    if not _is_under(dest_abs, root):
        raise VoiceInputError("vocal path escaped scratch")
    try:
        os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
    except OSError:
        traceback.print_exc()
        raise
    tmp = dest_abs + ".part"
    if not _is_under(tmp, root):
        raise VoiceInputError("vocal path escaped scratch")
    try:
        with open(tmp, "wb") as handle:
            handle.write(body)
        os.replace(tmp, dest_abs)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _render_pinned(
    reference: str,
    text: str,
    dest: str,
    *,
    scratch_root: str | None = None,
    prompt: str | None = None,
) -> str:
    """One files upload and one pinned music-01 prediction. No Lyria, no second model."""
    token = _audio_token()
    deadline = time.monotonic() + VOICE_TIMEOUT_SEC
    file_url = _upload_reference(reference, token, timeout=min(60.0, max(1.0, deadline - time.monotonic())))
    prediction = _run_prediction(token, file_url, text, deadline, prompt=prompt)
    audio_url = _output_url(prediction.get("output"))
    body = _download_output(audio_url, timeout=min(60.0, max(1.0, deadline - time.monotonic())))
    _write_vocal(dest, body, scratch_root=scratch_root)
    return dest


def process_voice_track(reference_audio_path: str, lyrics_or_text: str, session_id: str) -> str:
    """Clone/render a vocal and return ``scratch/{session_id}/{session_id}_vocal.wav``.

    Empty lyrics, a missing reference, and an unsafe session id raise
    ``VoiceInputError`` before any Replicate call.
    """
    text = _validate_lyrics(lyrics_or_text)
    session = _validate_session_id(session_id)
    reference = _validate_reference(reference_audio_path)
    dest = _destination(session)
    return _render_pinned(reference, text, dest)


def render_heart_mula_vocal(
    reference_audio_path: str,
    lyrics_or_text: str,
    session_id: str,
    dest_path: str | None = None,
) -> str:
    """One music-01 pass on the raw take. Writes ``heart_mula_vocal.wav``.

    Empty lyrics, a missing reference, and an unsafe path raise
    ``VoiceInputError`` before any Replicate call. The raw file is ``voice_file``.
    Nothing is sent to a speech model first.
    """
    text = _validate_lyrics(lyrics_or_text)
    session = _validate_session_id(session_id)
    reference = _validate_reference(reference_audio_path)
    if dest_path:
        dest = os.path.abspath(dest_path)
        if os.path.basename(dest) != "heart_mula_vocal.wav":
            raise VoiceInputError("invalid vocal path")
        if os.path.basename(os.path.dirname(dest)) != session:
            raise VoiceInputError("invalid vocal path")
        scratch_root = os.path.dirname(os.path.dirname(dest))
    else:
        scratch_root = os.path.abspath(SCRATCH_ROOT)
        dest = os.path.abspath(os.path.join(scratch_root, session, "heart_mula_vocal.wav"))
    if not _is_under(dest, scratch_root):
        raise VoiceInputError("vocal path escaped scratch")
    return _render_pinned(reference, text, dest, scratch_root=scratch_root)


def render_heart_mula_master(
    reference_audio_path: str,
    lyrics: str,
    prompt: str,
    session_id: str,
    dest_path: str,
) -> str:
    """One music-01 song. Writes ``{session_id}_master.wav``.

    ``voice_file`` is the raw reference. ``lyrics`` is the lyric text. The song
    prompt is validated and not sent: the pinned schema has no prompt field.
    No speech model and no Lyria run first. Empty lyrics, a missing reference,
    or an unsafe path raise ``VoiceInputError`` before any HTTP call.
    """
    text = _validate_lyrics(lyrics)
    song_prompt = (prompt or "").strip()
    if not song_prompt:
        raise VoiceInputError("prompt is required")
    if len(song_prompt) > MAX_LYRICS_CHARS:
        song_prompt = song_prompt[:MAX_LYRICS_CHARS].rstrip()
    session = _validate_session_id(session_id)
    reference = _validate_reference(reference_audio_path)
    dest = os.path.abspath(dest_path)
    if os.path.basename(dest) != f"{session}_master.wav":
        raise VoiceInputError("invalid master path")
    if os.path.basename(os.path.dirname(dest)) != session:
        raise VoiceInputError("invalid master path")
    scratch_root = os.path.dirname(os.path.dirname(dest))
    if not _is_under(dest, scratch_root):
        raise VoiceInputError("vocal path escaped scratch")
    return _render_pinned(reference, text, dest, scratch_root=scratch_root, prompt=song_prompt)
