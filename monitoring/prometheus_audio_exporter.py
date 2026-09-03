"""Live DSP metrics exporter. Binds 9192 so Prometheus TSDB keeps 9090."""
from __future__ import annotations

import os
import sqlite3
import time

from prometheus_client import Counter, Gauge, start_http_server

DB_PATH = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
# 9090 is HybridPrometheusDaemon (TSDB). 9191 is the workstation exporter.
METRICS_PORT = int(os.environ.get("PROMETHEUS_AUDIO_EXPORTER_PORT", "9192"))

TRUE_PEAK_GAUGE = Gauge(
    "hybrid_master_true_peak_dbtp",
    "True Peak of latest master render in dBTP",
    ["genre"],
)
PHASE_GAUGE = Gauge(
    "hybrid_master_phase_correlation",
    "Phase correlation coefficient of latest master",
    ["genre"],
)
RMS_GAUGE = Gauge(
    "hybrid_master_integrated_rms_dbfs",
    "Integrated RMS of latest master",
    ["genre"],
)
PROCESSED_SLICES = Counter("hybrid_processed_slices_total", "Total audio slices processed by stager")
ACTIVE_JOBS = Gauge("hybrid_pipeline_active_jobs", "Currently queued or processing audio sessions")

_last_mastered = 0


def poll_database_metrics() -> None:
    global _last_mastered
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT genre, true_peak_dbtp, phase_correlation
            FROM master_ledger
            ORDER BY updated_at DESC
            LIMIT 1
            """
        )
        row = cursor.fetchone()
        if row:
            genre, true_peak, phase = row
            label = genre or "unknown"
            if true_peak is not None:
                TRUE_PEAK_GAUGE.labels(genre=label).set(float(true_peak))
            if phase is not None:
                PHASE_GAUGE.labels(genre=label).set(float(phase))

        cursor.execute(
            """
            SELECT COUNT(*) FROM master_ledger
            WHERE upper(status) IN ('PROCESSING', 'PENDING')
            """
        )
        ACTIVE_JOBS.set(cursor.fetchone()[0])

        cursor.execute("SELECT COUNT(*) FROM master_ledger WHERE upper(status) = 'MASTERED'")
        mastered = cursor.fetchone()[0]
        if mastered > _last_mastered:
            PROCESSED_SLICES.inc(mastered - _last_mastered)
            _last_mastered = mastered
        conn.close()
    except Exception as exc:
        print(f"[METRICS POLL ERROR] {exc}")


if __name__ == "__main__":
    print(f"[*] Starting Prometheus Audio Exporter on port {METRICS_PORT}...")
    start_http_server(METRICS_PORT)
    while True:
        poll_database_metrics()
        time.sleep(5)
