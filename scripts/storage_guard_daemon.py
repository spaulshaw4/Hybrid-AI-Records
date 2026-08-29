# D:\MusicDatasets\scripts\storage_guard_daemon.py
import os
import time
import subprocess
import psutil

TARGET_DRIVE = "D:"
THRESHOLD_PCT = 15.0
CHECK_INTERVAL_SEC = 60
COOLDOWN_SEC = 300  # 5-minute cooldown between forced purges

BASE_DIR = r"D:\MusicDatasets"
RECLAIM_SCRIPT = os.path.join(BASE_DIR, "scripts", "reclaim_render_storage.ps1")
TELEMETRY_SCRIPT = os.path.join(BASE_DIR, "scripts", "log_telemetry.py")


def get_drive_free_percentage(drive_letter="D:"):
    try:
        usage = psutil.disk_usage(f"{drive_letter}\\")
        free_pct = (usage.free / usage.total) * 100.0
        free_gb = round(usage.free / (1024 ** 3), 2)
        total_gb = round(usage.total / (1024 ** 3), 2)
        return free_pct, free_gb, total_gb
    except Exception as e:
        print(f"[STORAGE GUARD ERROR] Failed to query disk metrics for {drive_letter}: {e}")
        return None, None, None


def trigger_emergency_reclamation(free_pct: float, free_gb: float):
    print(f"\n[STORAGE GUARD ALERT] Free space on {TARGET_DRIVE} is {free_pct:.2f}% ({free_gb} GB), below threshold of {THRESHOLD_PCT}%.")
    print("[STORAGE GUARD] Executing emergency storage reclamation with aggressive 2-hour window...")

    if os.path.exists(RECLAIM_SCRIPT):
        cmd = [
            "powershell.exe",
            "-ExecutionPolicy", "Bypass",
            "-File", RECLAIM_SCRIPT,
            "-BaseDir", BASE_DIR,
            "-MinAgeHours", "2"
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        print(proc.stdout)
        if proc.stderr:
            print(f"[RECLAMATION ERROR] {proc.stderr}")
    else:
        print(f"[STORAGE GUARD ERROR] Reclamation script not found at {RECLAIM_SCRIPT}")

    if os.path.exists(TELEMETRY_SCRIPT):
        meta_json = f'{{"triggered_by":"storage_guard_daemon","free_pct":{free_pct:.2f},"free_gb":{free_gb}}}'
        subprocess.run([
            "python", TELEMETRY_SCRIPT,
            "--event", "emergency_storage_reclamation_triggered",
            "--user", "00000000-0000-0000-0000-000000000001",
            "--metadata", meta_json
        ], capture_output=True, text=True)


def run_storage_guard():
    print("================================================================")
    print("HYBRID 1.0 - STORAGE GUARD DAEMON")
    print(f"Monitoring Drive : {TARGET_DRIVE}")
    print(f"Capacity Limit   : Trigger purge below {THRESHOLD_PCT}% free space")
    print(f"Polling Interval : Every {CHECK_INTERVAL_SEC} seconds")
    print("================================================================")

    last_reclaim_time = 0

    while True:
        free_pct, free_gb, total_gb = get_drive_free_percentage(TARGET_DRIVE)

        if free_pct is not None:
            current_time = time.time()

            if free_pct < THRESHOLD_PCT:
                if current_time - last_reclaim_time >= COOLDOWN_SEC:
                    trigger_emergency_reclamation(free_pct, free_gb)
                    last_reclaim_time = time.time()
                else:
                    remaining_cooldown = int(COOLDOWN_SEC - (current_time - last_reclaim_time))
                    print(f"[STORAGE GUARD] Low space ({free_pct:.2f}%), but waiting on cooldown ({remaining_cooldown}s remaining)...")

        time.sleep(CHECK_INTERVAL_SEC)


if __name__ == "__main__":
    run_storage_guard()
