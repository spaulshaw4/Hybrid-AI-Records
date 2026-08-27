#!/usr/bin/env python3
"""Atomic Hybrid Token spend/refund via existing Postgres RPCs."""
from __future__ import annotations

import os
from typing import Any

from audio_telemetry import supabase

HYBRID_MIX_TOKEN_AMOUNT = int(os.environ.get("HYBRID_MIX_TOKEN_AMOUNT") or "1")


def _rpc_row(data: Any) -> dict:
    if isinstance(data, list) and data:
        row = data[0]
        return row if isinstance(row, dict) else {}
    if isinstance(data, dict):
        return data
    return {}


def spend_hybrid_tokens(
    user_id: str,
    amount: int | None = None,
    note: str = "Hybrid vocal mix",
    idempotency_key: str | None = None,
) -> dict:
    """Call public.spend_hybrid_tokens. Amount is integer tokens (studio default 1)."""
    qty = int(amount if amount is not None else HYBRID_MIX_TOKEN_AMOUNT)
    if os.environ.get("DEV_BYPASS_TOKENS", "").lower() in {"1", "true"}:
        return {"ok": True, "balance": None, "already_applied": False, "bypassed": True}
    if not supabase:
        raise RuntimeError("Supabase service role is not configured.")
    res = supabase.rpc(
        "spend_hybrid_tokens",
        {
            "_user_id": user_id,
            "_amount": qty,
            "_note": note,
            "_idempotency_key": idempotency_key,
        },
    ).execute()
    row = _rpc_row(res.data)
    ok = bool(row.get("ok"))
    return {
        "ok": ok,
        "balance": row.get("balance"),
        "already_applied": bool(row.get("already_applied")),
        "reason": row.get("reason"),
        "bypassed": False,
        "amount": qty,
    }


def refund_hybrid_generation_tokens(
    user_id: str,
    amount: int | None = None,
    note: str = "Refund hybrid vocal mix enqueue failure",
    idempotency_key: str | None = None,
) -> dict:
    qty = int(amount if amount is not None else HYBRID_MIX_TOKEN_AMOUNT)
    if not supabase:
        raise RuntimeError("Supabase service role is not configured.")
    res = supabase.rpc(
        "refund_hybrid_generation_tokens",
        {
            "_user_id": user_id,
            "_amount": qty,
            "_note": note,
            "_idempotency_key": idempotency_key,
        },
    ).execute()
    row = _rpc_row(res.data)
    return {
        "ok": bool(row.get("ok")),
        "balance": row.get("balance"),
        "already_applied": bool(row.get("already_applied")),
        "reason": row.get("reason"),
    }
