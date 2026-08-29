# D:\MusicDatasets\scripts\prometheus_exporter.py
"""
Prometheus exporter for the Hybrid 1.0 workstation and pipeline.

Metric naming is load-bearing. monitoring/grafana/hybrid_workstation_dashboard.json
and monitoring/alerts.yml both query these series by name, so renaming one
silently blanks a dashboard panel or stops an alert from ever firing:

  hybrid_workstation_cpu_utilization_percent
  hybrid_workstation_ram_utilization_percent / _used_bytes / _total_bytes
  hybrid_workstation_disk_free_bytes{drive}
  hybrid_workstation_disk_utilization_percent{drive}
  hybrid_pipeline_sessions_total{status}
  hybrid_pipeline_stage_duration_seconds{stage}
  hybrid_stagnant_sessions_count
  hybrid_pipeline_autoheal_total{action}

node_filesystem_free_bytes / node_filesystem_size_bytes are also exported so
alert expressions written against node_exporter conventions resolve. node_exporter
itself is not installed on this workstation.
"""

import os
import sys
import time
import shutil
import threading
from datetime import datetime, timezone, timedelta

import psutil
from prometheus_client import start_http_server, Gauge, Counter, Info
from supabase import create_client, Client

PORT = int(os.environ.get("PROMETHEUS_EXPORTER_PORT", 9191))

# Loopback by default. Neither this exporter nor Prometheus has authentication,
# and it publishes session counts and hardware state.
BIND_ADDR = os.environ.get("PROMETHEUS_EXPORTER_HOST", "127.0.0.1")

POLL_INTERVAL_SEC = 15
BASE_DIR = r"D:\MusicDatasets"

# Must match STAGNATION_TIMEOUT_MINUTES in pipeline_stagnation_healer.py, or this
# metric disagrees with what the healer actually acts on.
STAGNATION_TIMEOUT_MINUTES = 20

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# -------------------------------------------------------------------------
# HARDWARE METRICS
# -------------------------------------------------------------------------
GAUGE_CPU = Gauge(
    "hybrid_workstation_cpu_utilization_percent",
    "CPU load percentage"
)
GAUGE_RAM_PCT = Gauge(
    "hybrid_workstation_ram_utilization_percent",
    "Memory load percentage"
)
GAUGE_RAM_USED = Gauge(
    "hybrid_workstation_ram_used_bytes",
    "Memory used in bytes"
)
GAUGE_RAM_TOTAL = Gauge(
    "hybrid_workstation_ram_total_bytes",
    "Total system RAM in bytes"
)
GAUGE_DISK_FREE = Gauge(
    "hybrid_workstation_disk_free_bytes",
    "Free storage in bytes",
    ["drive"]
)
GAUGE_DISK_PCT = Gauge(
    "hybrid_workstation_disk_utilization_percent",
    "Storage used percentage",
    ["drive"]
)

# node_exporter-compatible aliases for alert expressions written that way
GAUGE_STORAGE_FREE = Gauge(
    "node_filesystem_free_bytes",
    "Free disk space on volume in bytes",
    ["mountpoint"]
)
GAUGE_STORAGE_SIZE = Gauge(
    "node_filesystem_size_bytes",
    "Total disk capacity on volume in bytes",
    ["mountpoint"]
)

# -------------------------------------------------------------------------
# PIPELINE METRICS
# -------------------------------------------------------------------------
GAUGE_PIPELINE_SESSIONS = Gauge(
    "hybrid_pipeline_sessions_total",
    "Session counts by status",
    ["status"]
)
# Alias of the above. hybrid_workstation_dashboard.json queries
# hybrid_pipeline_sessions_total while hybrid_observability_dashboard.json
# queries hybrid_active_sessions; exporting both keeps either from going blank.
GAUGE_ACTIVE_SESSIONS = Gauge(
    "hybrid_active_sessions",
    "Session counts by status (alias of hybrid_pipeline_sessions_total)",
    ["status"]
)
GAUGE_STAGE_DURATION = Gauge(
    "hybrid_pipeline_stage_duration_seconds",
    "Most recent duration for each pipeline stage",
    ["stage"]
)
GAUGE_STAGNANT_SESSIONS = Gauge(
    "hybrid_stagnant_sessions_count",
    "Sessions in processing state exceeding the stagnation threshold"
)
COUNTER_AUTOHEAL_ACTIONS = Counter(
    "hybrid_pipeline_autoheal_total",
    "Total auto-heal actions executed by the stagnation healer daemon",
    ["action"]
)
SYSTEM_INFO = Info(
    "hybrid_pipeline_info",
    "Hybrid 1.0 Pipeline & Workstation Metadata"
)

STAGE_EVENTS = [
    "staging_completed",
    "inference_completed",
    "summation_completed",
    "hashing_completed",
    "upload_completed",
    "stems_purged",
    "pipeline_completed",
]

# Track processed telemetry log IDs to prevent duplicate counter increments
PROCESSED_TELEMETRY_IDS = set()


def init_supabase():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("[EXPORTER WARN] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured. Cloud metrics disabled.")
        return None
    try:
        return create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"[EXPORTER ERROR] Failed to initialize Supabase client: {e}")
        return None


def collect_hardware_metrics():
    try:
        GAUGE_CPU.set(psutil.cpu_percent(interval=0.5))

        vm = psutil.virtual_memory()
        GAUGE_RAM_PCT.set(vm.percent)
        GAUGE_RAM_USED.set(vm.used)
        GAUGE_RAM_TOTAL.set(vm.total)
    except Exception as e:
        print(f"[EXPORTER ERROR] Hardware metrics refresh failed: {e}")

    for drive in ["D:\\", "C:\\"]:
        if not os.path.exists(drive):
            continue
        try:
            usage = shutil.disk_usage(drive)
            label = drive.replace("\\", "")
            used_pct = (usage.used / usage.total) * 100.0 if usage.total else 0.0

            GAUGE_DISK_FREE.labels(drive=label).set(usage.free)
            GAUGE_DISK_PCT.labels(drive=label).set(used_pct)
            GAUGE_STORAGE_FREE.labels(mountpoint=label).set(usage.free)
            GAUGE_STORAGE_SIZE.labels(mountpoint=label).set(usage.total)
        except Exception as e:
            print(f"[EXPORTER ERROR] Error querying disk usage for {drive}: {e}")


def collect_supabase_metrics(client):
    if not client:
        return

    # 1. Session states, and stall detection, from user_vaults
    try:
        response = client.table("user_vaults").select("session_id, status, updated_at, created_at").execute()
        records = response.data or []

        status_counts = {"pending": 0, "processing": 0, "completed": 0, "failed": 0}
        stagnant_count = 0
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=STAGNATION_TIMEOUT_MINUTES)

        for rec in records:
            st = rec.get("status", "unknown")
            if st in status_counts:
                status_counts[st] += 1

            if st == "processing":
                raw = rec.get("updated_at") or rec.get("created_at")
                if not raw:
                    # No timestamp at all cannot self-recover; count it as stalled
                    stagnant_count += 1
                    continue
                try:
                    ts = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                    if ts < cutoff:
                        stagnant_count += 1
                except ValueError:
                    pass

        for st_label, count in status_counts.items():
            GAUGE_PIPELINE_SESSIONS.labels(status=st_label).set(count)
            GAUGE_ACTIVE_SESSIONS.labels(status=st_label).set(count)

        GAUGE_STAGNANT_SESSIONS.set(stagnant_count)
    except Exception as e:
        print(f"[EXPORTER ERROR] Failed to fetch session status counts: {e}")

    # 2. Latest duration per pipeline stage
    for stage in STAGE_EVENTS:
        try:
            res = (
                client.table("pipeline_telemetry_logs")
                .select("metadata")
                .eq("event_type", stage)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            if res.data:
                meta = res.data[0].get("metadata") or {}
                dur = meta.get("execution_duration_sec")
                if dur is not None:
                    label = stage.replace("_completed", "")
                    GAUGE_STAGE_DURATION.labels(stage=label).set(float(dur))
        except Exception:
            pass

    # 3. Healer auto-heal telemetry events
    try:
        telemetry_res = (
            client.table("pipeline_telemetry_logs")
            .select("id, event_type, metadata")
            .ilike("event_type", "pipeline_autoheal_%")
            .order("created_at", desc=True)
            .limit(100)
            .execute()
        )
        logs = telemetry_res.data or []

        # Oldest first, so the counter increments in chronological order
        for log_entry in reversed(logs):
            log_id = log_entry.get("id")
            if log_id in PROCESSED_TELEMETRY_IDS:
                continue

            event_type = log_entry.get("event_type", "")
            if "requeued" in event_type:
                action = "requeued"
            elif "failed" in event_type:
                action = "failed"
            else:
                action = "unknown"

            COUNTER_AUTOHEAL_ACTIONS.labels(action=action).inc()
            PROCESSED_TELEMETRY_IDS.add(log_id)

        # Bound memory. Discarding ids risks re-counting them on a later poll,
        # which shows up as a counter jump rather than lost data.
        if len(PROCESSED_TELEMETRY_IDS) > 5000:
            for _ in range(len(PROCESSED_TELEMETRY_IDS) - 2500):
                PROCESSED_TELEMETRY_IDS.pop()
    except Exception as e:
        print(f"[EXPORTER ERROR] Failed to fetch autoheal telemetry metrics: {e}")


def metric_collection_loop(client):
    while True:
        collect_hardware_metrics()
        collect_supabase_metrics(client)
        time.sleep(POLL_INTERVAL_SEC)


def main():
    print("================================================================")
    print("HYBRID 1.0 - PROMETHEUS METRICS EXPORTER")
    print(f"Scrape Endpoint  : http://{BIND_ADDR}:{PORT}/metrics")
    print(f"Polling Interval : {POLL_INTERVAL_SEC} seconds")
    print(f"Stall Threshold  : {STAGNATION_TIMEOUT_MINUTES} minutes")
    print("================================================================")

    SYSTEM_INFO.info({
        "version": "1.0.0",
        "pipeline": "hybrid_audio_processor",
        "workstation": "workstation-primary"
    })

    sb_client = init_supabase()

    start_http_server(PORT, addr=BIND_ADDR)
    print(f"[SUCCESS] Exporter listening on {BIND_ADDR}:{PORT}. Starting background collector thread...")

    collector_thread = threading.Thread(target=metric_collection_loop, args=(sb_client,), daemon=True)
    collector_thread.start()

    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
