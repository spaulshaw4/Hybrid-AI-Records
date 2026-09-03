"""SMTP fallback for payout alerts. Credentials come from env only.

Reads JSON on stdin: to, from, subject, text, html.
Uses SMTP_HOST, SMTP_USER, SMTP_PASSWORD, optional SMTP_PORT / SMTP_SECURE.
Never logs the password.
"""
from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import parseaddr


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def send_smtp(payload: dict) -> dict:
    host = _env("SMTP_HOST")
    user = _env("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD", "")
    if not host or not user or not password:
        return {"ok": False, "reason": "smtp_not_configured"}

    to_addr = str(payload.get("to") or "").strip()
    from_addr = str(payload.get("from") or "").strip()
    subject = str(payload.get("subject") or "").strip()
    text = str(payload.get("text") or "")
    html = str(payload.get("html") or "")
    if "@" not in to_addr or not from_addr or not subject:
        return {"ok": False, "reason": "invalid_message"}

    msg = EmailMessage()
    msg["To"] = to_addr
    msg["From"] = from_addr
    msg["Subject"] = subject
    msg.set_content(text or html)
    if html:
        msg.add_alternative(html, subtype="html")

    port = int(_env("SMTP_PORT") or "587")
    secure = _env("SMTP_SECURE").lower() in {"1", "true", "ssl", "tls"}
    envelope_from = parseaddr(from_addr)[1] or from_addr
    context = ssl.create_default_context()
    if port == 465 or secure:
        with smtplib.SMTP_SSL(host, port, timeout=20, context=context) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg, from_addr=envelope_from, to_addrs=[to_addr])
    else:
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            smtp.login(user, password)
            smtp.send_message(msg, from_addr=envelope_from, to_addrs=[to_addr])
    return {"ok": True}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "reason": "invalid_json"}))
        return 2
    try:
        result = send_smtp(payload if isinstance(payload, dict) else {})
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": "smtp_failed", "error": type(exc).__name__}))
        return 1
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
