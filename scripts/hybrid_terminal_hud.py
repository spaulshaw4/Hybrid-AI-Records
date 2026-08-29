# D:\MusicDatasets\scripts\hybrid_terminal_hud.py
"""
===============================================================================
HYBRID 1.0 - REAL-TIME OPERATIONAL TERMINAL HUD & LIVE WORKSTATION MONITOR
===============================================================================
Auto-refreshing operations matrix:
  - Status for all 9 Windows NSSM background services
  - Port connectivity matrix (9090, 9093, 9191, 5001, 8765, 3000)
  - Drive storage utilization and free headroom
  - Supabase pipeline queue metrics (pending, processing, completed, stagnant)
  - Single-key macro triggers (P: probe, H: heal, S: silence, R: restart, Q: quit)

Polling is tiered rather than uniform. A naive redraw re-queries all 9 services
via sc.exe plus Supabase on every frame; at a 2s refresh that is 9 process spawns
and a network round trip every 2 seconds, which is a meaningful load for a
monitor that is meant to sit open all day. Service and queue state are therefore
cached on longer intervals than the frame rate.
"""

import os
import sys
import time
import shutil
import socket
import subprocess
import threading
import argparse
from datetime import datetime, timezone, timedelta

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets")

C_RESET = "\033[0m"
C_BOLD = "\033[1m"
C_CYAN = "\033[36m"
C_GREEN = "\033[32m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_GRAY = "\033[90m"
C_WHITE = "\033[97m"

SERVICES = [
    ("Exporter Daemon",    "HybridPrometheusExporterDaemon", 9191),
    ("Prometheus Engine",  "HybridPrometheusDaemon",         9090),
    ("Alertmanager UI",    "HybridAlertmanagerDaemon",       9093),
    ("Notification Bridge","HybridAlertBridgeDaemon",        5001),
    ("Macro REST API",     "HybridHardwareMacroDaemon",      8765),
    ("Storage Guard",      "HybridStorageGuardDaemon",       None),
    ("Stagnation Healer",  "HybridStagnationHealerDaemon",   None),
    ("Watchdog Ingest",    "HybridWatchdogDaemon",           None),
    ("Audio Queue Poller", "HybridAudioDaemon",              None),
]

SERVICE_POLL_SEC = 10.0
QUEUE_POLL_SEC = 15.0

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")


def enable_ansi_on_windows():
    """
    Turn on virtual terminal processing.

    Windows consoles print raw escape sequences unless this is set, which would
    litter the HUD with '[36m' fragments instead of colour.
    """
    if os.name != "nt":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        pass


class TerminalHUD:
    def __init__(self, refresh_sec=2.0):
        self.running = True
        self.refresh_sec = refresh_sec
        self.last_action_msg = "HUD initialized. [P] Probe  [H] Heal  [S] Silence  [R] Restart  [Q] Quit"
        self.sb_client = None

        self._svc_cache = {}
        self._svc_ts = 0.0
        self._queue_cache = None
        self._queue_ts = 0.0
        self._queue_error = None

        self.init_supabase()

    def init_supabase(self):
        if not (SUPABASE_URL and SUPABASE_KEY):
            self._queue_error = "credentials not set"
            return
        try:
            from supabase import create_client
            self.sb_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        except Exception as e:
            self.sb_client = None
            self._queue_error = f"client init failed: {e}"

    def check_service(self, service_name: str) -> str:
        try:
            res = subprocess.run(["sc.exe", "query", service_name],
                                 capture_output=True, text=True, timeout=2)
            out = res.stdout.upper()
            if "RUNNING" in out:
                return "RUNNING"
            if "STOPPED" in out:
                return "STOPPED"
            if "PENDING" in out:
                return "PENDING"
            return "NOT_FOUND"
        except Exception:
            return "ERROR"

    def get_service_states(self) -> dict:
        now = time.time()
        if self._svc_cache and (now - self._svc_ts) < SERVICE_POLL_SEC:
            return self._svc_cache

        states = {}
        for _, sname, port in SERVICES:
            states[sname] = {
                "status": self.check_service(sname),
                "port_open": self.check_port(port) if port else None
            }

        self._svc_cache = states
        self._svc_ts = now
        return states

    def check_port(self, port) -> bool:
        if not port:
            return True
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except Exception:
            return False

    def get_storage_metrics(self):
        try:
            drive_root = os.path.splitdrive(BASE_DIR)[0] + os.sep
            usage = shutil.disk_usage(drive_root)
            return (round(usage.free / (1024 ** 3), 1),
                    round(usage.total / (1024 ** 3), 1),
                    round((usage.free / usage.total) * 100, 1))
        except Exception:
            return 0.0, 0.0, 0.0

    def get_queue_metrics(self) -> dict:
        now = time.time()
        if self._queue_cache and (now - self._queue_ts) < QUEUE_POLL_SEC:
            return self._queue_cache

        counts = {"pending": 0, "processing": 0, "completed": 0, "failed": 0, "stagnant": 0}

        if not self.sb_client:
            self._queue_cache = counts
            self._queue_ts = now
            return counts

        try:
            res = self.sb_client.table("user_vaults").select("status, updated_at, created_at").execute()
            rows = res.data or []
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=20)

            for r in rows:
                st = r.get("status", "unknown")
                if st in counts:
                    counts[st] += 1

                if st == "processing":
                    # Fall back to created_at: a row that was never updated still
                    # counts as stalled, and reading only updated_at would hide it.
                    stamp = r.get("updated_at") or r.get("created_at")
                    if stamp:
                        try:
                            if datetime.fromisoformat(str(stamp).replace("Z", "+00:00")) < cutoff:
                                counts["stagnant"] += 1
                        except Exception:
                            pass

            self._queue_error = None
        except Exception as e:
            self._queue_error = str(e)[:48]

        self._queue_cache = counts
        self._queue_ts = now
        return counts

    def draw(self):
        # Cursor home rather than cls: clearing the screen every frame causes a
        # visible flash, and overwriting in place does not.
        sys.stdout.write("\033[H\033[J")

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        free_gb, total_gb, pct_free = self.get_storage_metrics()
        q = self.get_queue_metrics()
        states = self.get_service_states()

        print(f"{C_BOLD}{C_CYAN}{'=' * 90}{C_RESET}")
        print(f"{C_BOLD}{C_WHITE}   HYBRID 1.0 // PIPELINE & WORKSTATION LIVE HUD MATRIX{C_RESET}")
        print(f"{C_GRAY}   workstation-primary | {now_str} | refresh {self.refresh_sec}s{C_RESET}")
        print(f"{C_BOLD}{C_CYAN}{'=' * 90}{C_RESET}")

        bar_len = 20
        used_pct = 100 - pct_free
        filled = int(used_pct / 100 * bar_len)
        cap_color = C_RED if pct_free < 5 else C_YELLOW if pct_free < 15 else C_GREEN
        bar_str = f"{cap_color}{'#' * filled}{C_GRAY}{'-' * (bar_len - filled)}{C_RESET}"

        print(f"\n{C_BOLD}[STORAGE - {os.path.splitdrive(BASE_DIR)[0] or 'D:'}]{C_RESET}")
        print(f"  Headroom : {C_WHITE}{free_gb} GB free / {total_gb} GB total ({cap_color}{pct_free}% available{C_RESET})")
        print(f"  Capacity : [{bar_str}] used {round(used_pct, 1)}%")

        print(f"\n{C_BOLD}[SUPABASE VAULT QUEUE]{C_RESET}")
        if self._queue_error:
            print(f"  {C_GRAY}unavailable: {self._queue_error}{C_RESET}")
        else:
            stall_color = C_RED if q["stagnant"] else C_GREEN
            print(f"  Pending: {C_YELLOW}{q['pending']}{C_RESET}  "
                  f"Processing: {C_CYAN}{q['processing']}{C_RESET}  "
                  f"Completed: {C_GREEN}{q['completed']}{C_RESET}  "
                  f"Failed: {C_RED}{q['failed']}{C_RESET}  "
                  f"Stalled >20m: {stall_color}{q['stagnant']}{C_RESET}")

        running = sum(1 for s in states.values() if s["status"] == "RUNNING")
        fleet_color = C_GREEN if running == len(SERVICES) else C_YELLOW if running else C_RED

        print(f"\n{C_BOLD}[DAEMON FLEET]{C_RESET} {fleet_color}{running}/{len(SERVICES)} running{C_RESET}")
        print(f"{C_GRAY}{'Daemon':<21}{'Service Identifier':<33}{'Port':<7}{'Status':<11}{'Socket'}{C_RESET}")
        print(f"{C_GRAY}{'-' * 86}{C_RESET}")

        for friendly, sname, port in SERVICES:
            info = states.get(sname, {"status": "?", "port_open": None})
            st = info["status"]
            st_color = C_GREEN if st == "RUNNING" else C_YELLOW if st == "PENDING" else C_RED

            if port is None:
                sock_str, sock_color = "n/a", C_GRAY
            elif info["port_open"]:
                sock_str, sock_color = "OPEN", C_GREEN
            else:
                sock_str, sock_color = "CLOSED", C_RED

            port_str = str(port) if port else "--"
            print(f"{friendly:<21}{sname:<33}{port_str:<7}"
                  f"{st_color}{st:<11}{C_RESET}{sock_color}{sock_str}{C_RESET}")

        print(f"\n{C_BOLD}{C_CYAN}{'-' * 90}{C_RESET}")
        print(f"{C_BOLD}[LAST ACTION]{C_RESET} {C_YELLOW}{self.last_action_msg}{C_RESET}")
        print(f"{C_GRAY}[P] E2E probe   [H] Heal sweep   [S] 60m silence   [R] Restart daemons   [Q] Quit{C_RESET}")
        print(f"{C_BOLD}{C_CYAN}{'=' * 90}{C_RESET}")

        sys.stdout.flush()

    def spawn(self, args: list):
        """Fire and forget, with output discarded so the HUD stays legible."""
        try:
            subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception as e:
            self.last_action_msg = f"launch failed: {e}"
            return False

    def trigger_action(self, key: str):
        key = key.upper()

        if key == "P":
            self.last_action_msg = "Firing synthetic E2E pipeline probe..."
            self.spawn([sys.executable, os.path.join(SCRIPTS_DIR, "test_pipeline_trigger.py")])

        elif key == "H":
            # --once, or every press would leave a permanently polling process behind.
            self.last_action_msg = "Running a single stagnation healer sweep..."
            self.spawn([sys.executable, os.path.join(SCRIPTS_DIR, "pipeline_stagnation_healer.py"), "--once"])

        elif key == "S":
            self.last_action_msg = "Creating a 60-minute Alertmanager silence..."
            self.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-File", os.path.join(SCRIPTS_DIR, "manage_alert_silences.ps1"),
                        "-Action", "create", "-DurationMinutes", "60"])

        elif key == "R":
            self.last_action_msg = "Restarting all daemons (needs elevation; may prompt)..."
            self.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-File", os.path.join(SCRIPTS_DIR, "manage_all_services.ps1"),
                        "-Action", "restart"])
            # Drop the cache so the next frame reflects the restart in progress
            self._svc_ts = 0.0

        elif key == "Q":
            self.running = False

    def input_listener(self):
        try:
            import msvcrt
        except ImportError:
            return

        while self.running:
            try:
                if msvcrt.kbhit():
                    self.trigger_action(msvcrt.getch().decode("utf-8", errors="ignore"))
            except Exception:
                pass
            time.sleep(0.1)

    def run(self):
        enable_ansi_on_windows()
        threading.Thread(target=self.input_listener, daemon=True).start()

        try:
            while self.running:
                self.draw()
                time.sleep(self.refresh_sec)
        except KeyboardInterrupt:
            pass
        finally:
            print(f"\n{C_GRAY}HUD terminated.{C_RESET}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 terminal operations HUD")
    parser.add_argument("--refresh", type=float, default=2.0, help="Frame interval in seconds")
    parser.add_argument("--once", action="store_true", help="Draw a single frame and exit")
    args = parser.parse_args()

    hud = TerminalHUD(refresh_sec=args.refresh)

    if args.once:
        enable_ansi_on_windows()
        hud.draw()
    else:
        hud.run()
