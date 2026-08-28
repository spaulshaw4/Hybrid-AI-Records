# scripts/worker_daemon.py
import os
import time
import subprocess
import glob

PAYLOAD_DIR = r"D:\MusicDatasets\job_payloads"
ENGINE_SCRIPT = r"D:\MusicDatasets\scripts\master_engine.py"
POLL_INTERVAL_SEC = 2


def run_worker_daemon():
    print(f"Hybrid 1.0 Worker Daemon active. Monitoring directory: {PAYLOAD_DIR}")
    os.makedirs(PAYLOAD_DIR, exist_ok=True)

    while True:
        try:
            # Scan for pending job payload json files
            payload_files = glob.glob(os.path.join(PAYLOAD_DIR, "job_*.json"))

            for payload_path in payload_files:
                print(f"[DAEMON] Processing job payload: {payload_path}")

                # Execute master engine synchronously for the discovered job payload
                process = subprocess.run(
                    ["python", ENGINE_SCRIPT, "--payload", payload_path],
                    capture_output=True,
                    text=True
                )

                if process.returncode == 0:
                    print(f"[DAEMON] Job successfully completed. Removing payload: {payload_path}")
                    os.remove(payload_path)
                else:
                    print(f"[DAEMON] Error executing master engine for {payload_path}:")
                    print(process.stderr)

                    # Move failed job payload to error subdirectory to prevent infinite loops
                    error_dir = os.path.join(PAYLOAD_DIR, "errors")
                    os.makedirs(error_dir, exist_ok=True)
                    os.rename(payload_path, os.path.join(error_dir, os.path.basename(payload_path)))

        except Exception as e:
            print(f"[DAEMON] Exception encountered in daemon loop: {e}")

        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    run_worker_daemon()
