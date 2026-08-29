# D:\MusicDatasets\scripts\analyze_telemetry_performance.py
import os
import math
import argparse
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def calculate_percentile(data: list[float], percentile: float) -> float:
    if not data:
        return 0.0

    sorted_data = sorted(data)

    if len(sorted_data) == 1:
        return sorted_data[0]

    k = (len(sorted_data) - 1) * (percentile / 100.0)
    floor_idx = math.floor(k)
    ceil_idx = math.ceil(k)

    if floor_idx == ceil_idx:
        return sorted_data[int(k)]

    d0 = sorted_data[int(floor_idx)] * (ceil_idx - k)
    d1 = sorted_data[int(ceil_idx)] * (k - floor_idx)

    return round(d0 + d1, 3)


def fetch_telemetry_logs(hours: int = None, limit: int = 5000) -> list[dict]:
    query = supabase.table("pipeline_telemetry_logs").select("*").order("created_at", desc=True).limit(limit)

    if hours:
        time_threshold = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        query = query.gte("created_at", time_threshold)

    response = query.execute()
    return response.data or []


def run_performance_analysis(hours: int = None, limit: int = 5000):
    print("================================================================")
    print("HYBRID 1.0 - TELEMETRY PERFORMANCE & LATENCY ANALYZER")
    print(f"Sampling Window: {f'Last {hours} hours' if hours else f'Last {limit} records'}")
    print("================================================================\n")

    logs = fetch_telemetry_logs(hours=hours, limit=limit)

    if not logs:
        print("[INFO] No telemetry logs found matching the query criteria.")
        return

    # Group step durations and hardware stats
    step_latencies = defaultdict(list)
    cpu_samples = []
    ram_samples = []
    disk_free_samples = []

    sessions_seen = set()
    completed_sessions = set()
    failed_sessions = set()
    timestamps = []

    for log in logs:
        event = log.get("event_type")
        meta = log.get("metadata") or {}
        session_id = meta.get("session_id")
        duration = meta.get("execution_duration_sec")

        if session_id:
            sessions_seen.add(session_id)
            if event == "pipeline_completed":
                completed_sessions.add(session_id)
            elif event == "pipeline_failed":
                failed_sessions.add(session_id)

        if duration is not None and float(duration) > 0:
            step_latencies[event].append(float(duration))

        # Hardware metrics extraction
        hw = meta.get("hardware")
        if hw:
            if "cpu_utilization_pct" in hw and hw["cpu_utilization_pct"] is not None:
                cpu_samples.append(float(hw["cpu_utilization_pct"]))
            if "ram_utilization_pct" in hw and hw["ram_utilization_pct"] is not None:
                ram_samples.append(float(hw["ram_utilization_pct"]))
            if "disk_free_gb" in hw and hw["disk_free_gb"] is not None:
                disk_free_samples.append(float(hw["disk_free_gb"]))

        # Parse timestamp for throughput
        created_at_str = log.get("created_at")
        if created_at_str:
            try:
                dt = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
                timestamps.append(dt)
            except ValueError:
                pass

    # 1. Step Latency Percentiles Table
    print("STAGE EXECUTION LATENCY BREAKDOWN (Seconds):")
    print(f"{'Pipeline Stage':<28} | {'Count':<6} | {'Mean':<7} | {'p50':<7} | {'p95':<7} | {'p99':<7} | {'Max':<7}")
    print("-" * 80)

    display_stages = [
        "staging_completed",
        "inference_completed",
        "summation_completed",
        "hashing_completed",
        "upload_completed",
        "pipeline_completed"
    ]

    # Include any extra custom stages found in logs
    all_stages = display_stages + [s for s in step_latencies if s not in display_stages]

    for stage in all_stages:
        samples = step_latencies.get(stage, [])
        if not samples:
            continue

        count = len(samples)
        mean_val = round(sum(samples) / count, 3)
        p50 = calculate_percentile(samples, 50)
        p95 = calculate_percentile(samples, 95)
        p99 = calculate_percentile(samples, 99)
        max_val = round(max(samples), 3)

        label = stage.replace("_completed", "").replace("_", " ").title()
        if stage == "pipeline_completed":
            label = "TOTAL PIPELINE"

        print(f"{label:<28} | {count:<6} | {mean_val:<7.3f} | {p50:<7.3f} | {p95:<7.3f} | {p99:<7.3f} | {max_val:<7.3f}")

    # 2. Throughput & Reliability Metrics
    print("\n" + "=" * 80)
    print("PIPELINE THROUGHPUT & RELIABILITY:")
    print("-" * 80)
    print(f"  Total Telemetry Records Analyzed : {len(logs)}")
    print(f"  Unique Pipeline Sessions        : {len(sessions_seen)}")
    print(f"  Successfully Completed Sessions : {len(completed_sessions)}")
    print(f"  Failed Pipeline Sessions        : {len(failed_sessions)}")

    if sessions_seen:
        success_rate = (len(completed_sessions) / len(sessions_seen)) * 100.0
        print(f"  Session Success Rate            : {success_rate:.2f}%")

    if timestamps:
        duration_delta = max(timestamps) - min(timestamps)
        total_seconds = duration_delta.total_seconds()

        if total_seconds > 0:
            events_per_sec = round(len(logs) / total_seconds, 2)
            sessions_per_min = round((len(completed_sessions) / (total_seconds / 60.0)), 2)
            print(f"  Time Horizon Covered            : {str(duration_delta).split('.')[0]}")
            print(f"  Telemetry Ingestion Throughput  : {events_per_sec} events/sec")
            print(f"  Master Render Completion Rate   : {sessions_per_min} sessions/min")

    # 3. Hardware Resource Utilization Averages
    print("\n" + "=" * 80)
    print("WORKSTATION HARDWARE CONSUMPTION (Averages):")
    print("-" * 80)

    if cpu_samples:
        avg_cpu = sum(cpu_samples) / len(cpu_samples)
        p95_cpu = calculate_percentile(cpu_samples, 95)
        print(f"  CPU Utilization                 : Avg {avg_cpu:.1f}% | p95 {p95_cpu:.1f}%")

    if ram_samples:
        avg_ram = sum(ram_samples) / len(ram_samples)
        p95_ram = calculate_percentile(ram_samples, 95)
        print(f"  System RAM Utilization          : Avg {avg_ram:.1f}% | p95 {p95_ram:.1f}%")

    if disk_free_samples:
        avg_free_disk = sum(disk_free_samples) / len(disk_free_samples)
        min_free_disk = min(disk_free_samples)
        print(f"  Target Volume (D:) Free Space   : Avg {avg_free_disk:.1f} GB | Min Observed {min_free_disk:.1f} GB")

    print("================================================================\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Telemetry Performance & Latency Analyzer")
    parser.add_argument("--hours", type=int, default=None, help="Filter records to the last N hours")
    parser.add_argument("--limit", type=int, default=5000, help="Max telemetry records to fetch (default: 5000)")
    args = parser.parse_args()

    run_performance_analysis(hours=args.hours, limit=args.limit)
