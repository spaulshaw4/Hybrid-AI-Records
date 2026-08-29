# D:\MusicDatasets\scripts\prometheus_exporter.py
import os
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

import psutil
from supabase import create_client, Client

PORT = int(os.environ.get("PROMETHEUS_EXPORTER_PORT", 9191))
POLL_INTERVAL_SEC = 15
TARGET_DRIVE = "D:"

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Shared metrics state
METRICS = {
    "cpu_pct": 0.0,
    "ram_pct": 0.0,
    "ram_used_bytes": 0,
    "ram_total_bytes": 0,
    "disk_free_bytes": 0,
    "disk_total_bytes": 0,
    "disk_pct": 0.0,
    "sessions_pending": 0,
    "sessions_processing": 0,
    "sessions_completed": 0,
    "sessions_failed": 0,
    "stage_durations": {
        "staging_completed": 0.0,
        "inference_completed": 0.0,
        "summation_completed": 0.0,
        "hashing_completed": 0.0,
        "upload_completed": 0.0,
        "pipeline_completed": 0.0
    },
    "last_scrape_ts": 0
}

METRICS_LOCK = threading.Lock()


def update_hardware_metrics():
    try:
        cpu = psutil.cpu_percent(interval=0.5)
        vm = psutil.virtual_memory()
        usage = psutil.disk_usage(f"{TARGET_DRIVE}\\")

        with METRICS_LOCK:
            METRICS["cpu_pct"] = cpu
            METRICS["ram_pct"] = vm.percent
            METRICS["ram_used_bytes"] = vm.used
            METRICS["ram_total_bytes"] = vm.total
            METRICS["disk_free_bytes"] = usage.free
            METRICS["disk_total_bytes"] = usage.total
            METRICS["disk_pct"] = usage.percent
    except Exception as e:
        print(f"[METRICS ERROR] Hardware metrics refresh failed: {e}")


def update_pipeline_metrics():
    try:
        # 1. Query current session counts by status.
        #    Uses an exact count per status so results are not capped by the
        #    PostgREST default row limit.
        counts = {"pending": 0, "processing": 0, "completed": 0, "failed": 0}
        for status in counts:
            res = (
                supabase.table("user_vaults")
                .select("session_id", count="exact")
                .eq("status", status)
                .limit(1)
                .execute()
            )
            counts[status] = res.count if res.count is not None else len(res.data or [])

        # 2. Query latest stage durations from telemetry logs
        stages = list(METRICS["stage_durations"].keys())
        latest_durations = {}

        for stage in stages:
            t_res = (
                supabase.table("pipeline_telemetry_logs")
                .select("metadata")
                .eq("event_type", stage)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            if t_res.data and len(t_res.data) > 0:
                meta = t_res.data[0].get("metadata") or {}
                dur = meta.get("execution_duration_sec")
                if dur is not None:
                    latest_durations[stage] = float(dur)

        with METRICS_LOCK:
            METRICS["sessions_pending"] = counts["pending"]
            METRICS["sessions_processing"] = counts["processing"]
            METRICS["sessions_completed"] = counts["completed"]
            METRICS["sessions_failed"] = counts["failed"]
            for stage, dur in latest_durations.items():
                METRICS["stage_durations"][stage] = dur
            METRICS["last_scrape_ts"] = int(time.time())
    except Exception as e:
        print(f"[METRICS ERROR] Pipeline telemetry refresh failed: {e}")


def background_collector():
    while True:
        update_hardware_metrics()
        update_pipeline_metrics()
        time.sleep(POLL_INTERVAL_SEC)


class PrometheusMetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
            return

        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return

        with METRICS_LOCK:
            output = []

            output.append("# HELP hybrid_workstation_cpu_utilization_percent CPU load percentage")
            output.append("# TYPE hybrid_workstation_cpu_utilization_percent gauge")
            output.append(f"hybrid_workstation_cpu_utilization_percent {METRICS['cpu_pct']}")

            output.append("# HELP hybrid_workstation_ram_utilization_percent Memory load percentage")
            output.append("# TYPE hybrid_workstation_ram_utilization_percent gauge")
            output.append(f"hybrid_workstation_ram_utilization_percent {METRICS['ram_pct']}")

            output.append("# HELP hybrid_workstation_ram_used_bytes Memory used in bytes")
            output.append("# TYPE hybrid_workstation_ram_used_bytes gauge")
            output.append(f"hybrid_workstation_ram_used_bytes {METRICS['ram_used_bytes']}")

            output.append("# HELP hybrid_workstation_ram_total_bytes Total system RAM in bytes")
            output.append("# TYPE hybrid_workstation_ram_total_bytes gauge")
            output.append(f"hybrid_workstation_ram_total_bytes {METRICS['ram_total_bytes']}")

            output.append('# HELP hybrid_workstation_disk_free_bytes Target drive free storage in bytes')
            output.append('# TYPE hybrid_workstation_disk_free_bytes gauge')
            output.append(f'hybrid_workstation_disk_free_bytes{{drive="{TARGET_DRIVE}"}} {METRICS["disk_free_bytes"]}')

            output.append('# HELP hybrid_workstation_disk_utilization_percent Target drive space used percentage')
            output.append('# TYPE hybrid_workstation_disk_utilization_percent gauge')
            output.append(f'hybrid_workstation_disk_utilization_percent{{drive="{TARGET_DRIVE}"}} {METRICS["disk_pct"]}')

            output.append("# HELP hybrid_pipeline_sessions_total Active and historic session counts by status")
            output.append("# TYPE hybrid_pipeline_sessions_total gauge")
            output.append(f'hybrid_pipeline_sessions_total{{status="pending"}} {METRICS["sessions_pending"]}')
            output.append(f'hybrid_pipeline_sessions_total{{status="processing"}} {METRICS["sessions_processing"]}')
            output.append(f'hybrid_pipeline_sessions_total{{status="completed"}} {METRICS["sessions_completed"]}')
            output.append(f'hybrid_pipeline_sessions_total{{status="failed"}} {METRICS["sessions_failed"]}')

            output.append("# HELP hybrid_pipeline_stage_duration_seconds Latest duration for each pipeline stage")
            output.append("# TYPE hybrid_pipeline_stage_duration_seconds gauge")
            for stage, dur in METRICS["stage_durations"].items():
                stage_label = stage.replace("_completed", "")
                output.append(f'hybrid_pipeline_stage_duration_seconds{{stage="{stage_label}"}} {dur}')

            payload = "\n".join(output) + "\n"

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def log_message(self, format, *args):
        # Silence default request logging to avoid log noise
        return


def run_exporter():
    bind_host = os.environ.get("PROMETHEUS_EXPORTER_HOST", "127.0.0.1")

    print("================================================================")
    print("HYBRID 1.0 - PROMETHEUS METRICS EXPORTER")
    print(f"Metrics Endpoint : http://{bind_host}:{PORT}/metrics")
    print(f"Health Check     : http://{bind_host}:{PORT}/healthz")
    print(f"Sampling Period  : {POLL_INTERVAL_SEC} seconds")
    print("================================================================")

    collector_thread = threading.Thread(target=background_collector, daemon=True)
    collector_thread.start()

    server = HTTPServer((bind_host, PORT), PrometheusMetricsHandler)
    server.serve_forever()


if __name__ == "__main__":
    run_exporter()
