"""HMAC-SHA256 signing for Hybrid AI Forge webhooks.

Secret is read from WEBHOOK_SECRET or FRONTEND_WEBHOOK_SECRET. There is no
hardcoded fallback — if neither is set, generate_webhook_signature returns
an empty string so callers skip the X-Hybrid-Signature header.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os


def _webhook_secret() -> str:
    return (
        os.environ.get("WEBHOOK_SECRET")
        or os.environ.get("FRONTEND_WEBHOOK_SECRET")
        or ""
    ).strip()


def canonical_webhook_body(payload: dict) -> str:
    return json.dumps(payload, sort_keys=True)


def generate_webhook_signature(payload: dict) -> str:
    """HMAC-SHA256 hex digest of json.dumps(payload, sort_keys=True).

    Returns "" when no secret is configured so callers can omit the header.
    """
    secret = _webhook_secret()
    if not secret:
        return ""
    body = canonical_webhook_body(payload)
    return hmac.new(
        secret.encode("utf-8"),
        body.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_webhook_signature(payload: dict, received_signature: str | None) -> bool:
    if not received_signature or not isinstance(received_signature, str):
        return False
    expected = generate_webhook_signature(payload)
    if not expected:
        return False
    try:
        return hmac.compare_digest(expected, received_signature)
    except (TypeError, ValueError):
        return False
