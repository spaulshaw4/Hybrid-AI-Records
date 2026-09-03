"""Token balance exporter. Binds 9193 so 9090/9191/9192 stay assigned.

Port map:
  9090  Prometheus TSDB
  9191  workstation exporter
  9192  audio / DSP exporter
  9193  token balances (this process)

Balances come from ``user_tokens``. Credit/debit *counts* come from the
existing event tables. This process does not invent USD revenue from genre
or session_id heuristics. ``hybrid_token_unit_price_usd`` is the documented
catalog list price (artist $1.00, hybrid $2.50, render $30.00).
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time

from prometheus_client import CollectorRegistry, Gauge, generate_latest, start_http_server

DB_PATH = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
# 9092 was requested; 9193 avoids colliding with 9090 TSDB and keeps the 919x exporter band.
METRICS_PORT = int(os.environ.get("PROMETHEUS_TOKEN_EXPORTER_PORT", "9193"))

# Catalog list prices from ArtistTokenWallet / stripe-webhook-fulfill (USD per token).
UNIT_PRICE_USD = {"artist": 1.00, "hybrid": 2.50, "render": 30.00}


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def make_registry() -> tuple[CollectorRegistry, dict]:
    registry = CollectorRegistry()
    metrics = {
        "balance": Gauge(
            "hybrid_token_balance",
            "Live token balance from user_tokens",
            ["user_id", "token_type"],
            registry=registry,
        ),
        "balance_total": Gauge(
            "hybrid_token_balance_total",
            "Sum of user_tokens.balance by token_type",
            ["token_type"],
            registry=registry,
        ),
        "unit_price": Gauge(
            "hybrid_token_unit_price_usd",
            "Documented catalog list price per token in USD (not ledger-derived revenue)",
            ["token_type"],
            registry=registry,
        ),
        "credits": Gauge(
            "hybrid_token_credits_total",
            "Tokens credited via token_credit_events (count, not USD)",
            ["token_type"],
            registry=registry,
        ),
        "debits": Gauge(
            "hybrid_token_debits_total",
            "Tokens debited via token_debit_events (count, not USD)",
            ["token_type"],
            registry=registry,
        ),
    }
    return registry, metrics


def poll_token_metrics(db_path: str, metrics: dict) -> None:
    for token_type, price in UNIT_PRICE_USD.items():
        metrics["unit_price"].labels(token_type=token_type).set(price)
        metrics["balance_total"].labels(token_type=token_type).set(0)
        metrics["credits"].labels(token_type=token_type).set(0)
        metrics["debits"].labels(token_type=token_type).set(0)

    if not os.path.isfile(db_path):
        return

    conn = sqlite3.connect(db_path, timeout=10)
    try:
        if _table_exists(conn, "user_tokens"):
            totals: dict[str, int] = {name: 0 for name in UNIT_PRICE_USD}
            rows = conn.execute("SELECT user_id, token_type, balance FROM user_tokens").fetchall()
            for user_id, token_type, balance in rows:
                key = str(token_type or "").lower()
                amount = int(balance or 0)
                metrics["balance"].labels(user_id=str(user_id or "unknown"), token_type=key or "unknown").set(amount)
                if key in totals:
                    totals[key] += amount
            for token_type, total in totals.items():
                metrics["balance_total"].labels(token_type=token_type).set(total)

        if _table_exists(conn, "token_credit_events"):
            for token_type, total in conn.execute(
                "SELECT lower(token_type), COALESCE(SUM(tokens), 0) FROM token_credit_events GROUP BY lower(token_type)"
            ):
                metrics["credits"].labels(token_type=str(token_type or "unknown")).set(int(total or 0))

        if _table_exists(conn, "token_debit_events"):
            for token_type, total in conn.execute(
                "SELECT lower(token_type), COALESCE(SUM(tokens), 0) FROM token_debit_events GROUP BY lower(token_type)"
            ):
                metrics["debits"].labels(token_type=str(token_type or "unknown")).set(int(total or 0))
    finally:
        conn.close()


def render_once(db_path: str) -> bytes:
    registry, metrics = make_registry()
    poll_token_metrics(db_path, metrics)
    return generate_latest(registry)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export token balances on 9193 (or --once to stdout).")
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--port", type=int, default=METRICS_PORT)
    parser.add_argument("--once", action="store_true", help="Print Prometheus text and exit (no HTTP server).")
    args = parser.parse_args()
    if args.port == 9090:
        print("[FATAL] refusing to bind 9090 (Prometheus TSDB).", flush=True)
        return 2
    if args.once:
        sys.stdout.buffer.write(render_once(args.db))
        return 0

    registry, metrics = make_registry()
    print(f"[*] Starting Prometheus Token Exporter on port {args.port}...")
    start_http_server(args.port, registry=registry)
    while True:
        try:
            poll_token_metrics(args.db, metrics)
        except Exception as exc:
            print(f"[METRICS POLL ERROR] {exc}")
        time.sleep(5)


if __name__ == "__main__":
    raise SystemExit(main())
