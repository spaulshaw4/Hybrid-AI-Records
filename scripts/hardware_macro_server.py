# D:\MusicDatasets\scripts\hardware_macro_server.py
"""
Hybrid 1.0 - Hardware Macro & Stream Deck REST control server.

Serves a touch-ready web deck and a small REST API that fires operational
macros (probe, healer sweep, alert silence, DR backup, daemon restart).

Security posture
----------------
Every macro here is state-changing, and several are destructive or
availability-affecting, so the surface is closed by default:

  * Binds 127.0.0.1. Stream Deck software runs on the same machine, so this is
    sufficient for the normal case. LAN exposure is opt-in via --allow-lan,
    which then REQUIRES a token.
  * No CORS headers. The deck UI is served from this same origin, so it needs
    none, and 'Access-Control-Allow-Origin: *' would let any site you happen to
    be browsing read responses from this server.
  * GET never mutates. Macros are POST-only and additionally require the
    X-Hybrid-Token header. A custom header cannot be attached to a cross-origin
    request without a CORS preflight this server refuses, which is what stops a
    drive-by <img src="...:8765/api/macro/restart-daemons"> from firing a macro.
  * Token is compared with compare_digest to avoid leaking length or prefix
    through timing.

Set HYBRID_MACRO_TOKEN to pin the token; otherwise one is generated per start
and printed once to the log.
"""

import os
import sys
import json
import time
import shutil
import secrets
import hmac
import subprocess
import threading
import webbrowser
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

DEFAULT_PORT = 8765
BASE_DIR = os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets")
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")

SERVICES = [
    "HybridPrometheusExporterDaemon",
    "HybridPrometheusDaemon",
    "HybridAlertmanagerDaemon",
    "HybridAlertBridgeDaemon",
    "HybridStorageGuardDaemon",
    "HybridStagnationHealerDaemon",
    "HybridWatchdogDaemon",
    "HybridAudioDaemon"
]

AUTH_TOKEN = None
REQUIRE_TOKEN = True

# Cache service status: sc.exe query across 8 services on every status poll
# would spawn 8 processes every 5 seconds per connected client.
_status_cache = {"data": None, "ts": 0.0}
_STATUS_TTL_SEC = 4.0


def get_system_status() -> dict:
    now = time.time()
    if _status_cache["data"] and (now - _status_cache["ts"]) < _STATUS_TTL_SEC:
        return _status_cache["data"]

    svc_status = {}
    running_count = 0

    for s in SERVICES:
        try:
            res = subprocess.run(["sc.exe", "query", s], capture_output=True, text=True, timeout=2)
            out = res.stdout.upper()
            if "RUNNING" in out:
                st = "RUNNING"
            elif "STOPPED" in out:
                st = "STOPPED"
            else:
                st = "NOT_INSTALLED"
        except Exception:
            st = "UNKNOWN"

        svc_status[s] = st
        if st == "RUNNING":
            running_count += 1

    free_gb = total_gb = 0.0
    drive_root = os.path.splitdrive(BASE_DIR)[0] + os.sep
    if os.path.exists(drive_root):
        u = shutil.disk_usage(drive_root)
        free_gb = round(u.free / (1024 ** 3), 2)
        total_gb = round(u.total / (1024 ** 3), 2)

    data = {
        "services_running": f"{running_count}/{len(SERVICES)}",
        "service_matrix": svc_status,
        "storage_d_free_gb": free_gb,
        "storage_d_total_gb": total_gb,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
    }

    _status_cache["data"] = data
    _status_cache["ts"] = now
    return data


def execute_async_action(cmd_args: list):
    threading.Thread(
        target=lambda: subprocess.run(cmd_args, capture_output=True),
        daemon=True
    ).start()


def python_exe() -> str:
    """sys.executable, so macros use the same interpreter the service runs under."""
    return sys.executable or "python"


HTML_DASHBOARD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hybrid 1.0 - Stream Deck Control Wall</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; }
  body { background-color: #09090b; color: #f4f4f5; display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 24px; }
  .header { width: 100%; max-width: 960px; display: flex; justify-content: space-between; align-items: center; padding-bottom: 20px; border-bottom: 1px solid #27272a; margin-bottom: 24px; gap: 16px; flex-wrap: wrap; }
  .title { font-size: 20px; font-weight: 800; letter-spacing: 1px; color: #38bdf8; }
  .status-badge { background: #18181b; border: 1px solid #3f3f46; padding: 6px 14px; border-radius: 9999px; font-size: 13px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; width: 100%; max-width: 960px; margin-bottom: 24px; }
  .macro-card { background: #18181b; border: 2px solid #27272a; border-radius: 12px; padding: 20px 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; cursor: pointer; transition: all 0.15s ease; user-select: none; }
  .macro-card:hover { border-color: #38bdf8; background: #27272a; transform: translateY(-2px); }
  .macro-card:active { transform: scale(0.97); }
  .macro-num { font-size: 11px; font-weight: 800; color: #71717a; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 1px; }
  .macro-title { font-size: 16px; font-weight: 700; color: #fafafa; margin-bottom: 6px; }
  .macro-desc { font-size: 12px; color: #a1a1aa; }
  .c-probe { border-color: #0284c7; } .c-heal { border-color: #eab308; } .c-silence { border-color: #a855f7; }
  .c-restart { border-color: #ef4444; } .c-grafana { border-color: #22c55e; } .c-logs { border-color: #06b6d4; }
  .c-backup { border-color: #f97316; } .c-health { border-color: #3b82f6; }
  #feedback { width: 100%; max-width: 960px; background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 14px; font-size: 13px; color: #38bdf8; min-height: 48px; display: flex; align-items: center; }
  .confirming { border-color: #ef4444 !important; background: #450a0a !important; }
</style>
</head>
<body>
  <div class="header">
    <div class="title">HYBRID 1.0 // HARDWARE MACRO WALL</div>
    <div class="status-badge" id="stats">Active Daemons: -- | Storage: --</div>
  </div>
  <div class="grid">
    <div class="macro-card c-probe" onclick="runMacro(this, 'POST', '/api/macro/probe', 'E2E Synthetic Pipeline Probe')">
      <div class="macro-num">Macro 01</div>
      <div class="macro-title">Instant Probe</div>
      <div class="macro-desc">Synthesize stems &amp; fire test session</div>
    </div>
    <div class="macro-card c-heal" onclick="runMacro(this, 'POST', '/api/macro/heal', 'Stagnation Healer Sweep')">
      <div class="macro-num">Macro 02</div>
      <div class="macro-title">Healer Sweep</div>
      <div class="macro-desc">Purge hangs &amp; re-queue stalls</div>
    </div>
    <div class="macro-card c-silence" onclick="runMacro(this, 'POST', '/api/macro/silence?minutes=60', '60-Minute Alert Silence')">
      <div class="macro-num">Macro 03</div>
      <div class="macro-title">60m Silence</div>
      <div class="macro-desc">Alertmanager maintenance window</div>
    </div>
    <div class="macro-card c-grafana" onclick="openUrl('grafana', 'Grafana Observability UI')">
      <div class="macro-num">Macro 04</div>
      <div class="macro-title">Grafana (3000)</div>
      <div class="macro-desc">Open real-time telemetry dashboard</div>
    </div>
    <div class="macro-card c-logs" onclick="runMacro(this, 'POST', '/api/macro/open/logs', 'Live Log Streamer')">
      <div class="macro-num">Macro 05</div>
      <div class="macro-title">Stream Logs</div>
      <div class="macro-desc">Spawn multi-daemon log tail window</div>
    </div>
    <div class="macro-card c-health" onclick="runMacro(this, 'POST', '/api/macro/health', 'Pipeline Health Audit')">
      <div class="macro-num">Macro 06</div>
      <div class="macro-title">Health Check</div>
      <div class="macro-desc">Run full readiness audit script</div>
    </div>
    <div class="macro-card c-backup" onclick="runMacro(this, 'POST', '/api/macro/backup', 'Disaster Recovery Snapshot')">
      <div class="macro-num">Macro 07</div>
      <div class="macro-title">DR Backup</div>
      <div class="macro-desc">Write complete system backup archive</div>
    </div>
    <div class="macro-card c-restart" onclick="runMacro(this, 'POST', '/api/macro/restart-daemons', 'Restart All 8 Daemons', true)">
      <div class="macro-num">Macro 08</div>
      <div class="macro-title">Restart Daemons</div>
      <div class="macro-desc">Orchestrate full service reload</div>
    </div>
  </div>
  <div id="feedback">System Ready. Touch or invoke any hardware button to execute.</div>
  <script>
    // Injected by the server so the same-origin deck can authenticate without
    // the operator pasting anything.
    const TOKEN = "__TOKEN_PLACEHOLDER__";
    const pending = new Set();

    function headers() {
      return { "Content-Type": "application/json", "X-Hybrid-Token": TOKEN };
    }

    function updateStatus() {
      fetch('/api/macro/status', { headers: headers() })
        .then(r => r.json())
        .then(d => {
          document.getElementById('stats').innerText =
            `Active Daemons: ${d.services_running} | Free: ${d.storage_d_free_gb} GB`;
        }).catch(() => {});
    }

    function openUrl(which, label) {
      const fb = document.getElementById('feedback');
      // Opened by the browser, not the server: a service running as SYSTEM has
      // no interactive desktop to launch a browser onto.
      const urls = { grafana: 'http://localhost:3000', prometheus: 'http://localhost:9090', alertmanager: 'http://localhost:9093' };
      window.open(urls[which], '_blank');
      fb.innerText = `[OPENED] ${label}`;
    }

    function runMacro(el, method, endpoint, label, needsConfirm) {
      const fb = document.getElementById('feedback');

      // Two-tap confirm for destructive macros, so a stray touch on a tablet
      // propped next to the desk cannot bounce every daemon.
      if (needsConfirm && !pending.has(endpoint)) {
        pending.add(endpoint);
        el.classList.add('confirming');
        fb.innerText = `[CONFIRM] Tap again within 4s to ${label}`;
        setTimeout(() => { pending.delete(endpoint); el.classList.remove('confirming'); }, 4000);
        return;
      }

      pending.delete(endpoint);
      el.classList.remove('confirming');
      fb.innerText = `[EXECUTING] ${label}...`;

      fetch(endpoint, { method: method, headers: headers() })
        .then(r => r.json().then(d => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          fb.innerText = ok
            ? `[SUCCESS] ${label} (${d.status || 'done'})`
            : `[ERROR] ${label}: ${d.error || 'rejected'}`;
          updateStatus();
        })
        .catch(err => { fb.innerText = `[ERROR] ${label}: ${err}`; });
    }

    setInterval(updateStatus, 5000);
    updateStatus();
  </script>
</body>
</html>
"""


class MacroHandler(BaseHTTPRequestHandler):
    server_version = "Hybrid10Macro/1.0"

    def send_json(self, status_code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Deliberately no Access-Control-Allow-Origin: the deck is same-origin,
        # and a wildcard would let any browsed site read these responses.
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        if not REQUIRE_TOKEN:
            return True
        supplied = self.headers.get("X-Hybrid-Token", "")
        return bool(AUTH_TOKEN) and hmac.compare_digest(supplied, AUTH_TOKEN)

    def reject_unauthorized(self):
        self.send_json(401, {"error": "missing or invalid X-Hybrid-Token"})

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path in ("/", "/dashboard"):
            page = HTML_DASHBOARD.replace("__TOKEN_PLACEHOLDER__", AUTH_TOKEN or "")
            body = page.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            # The deck page embeds the token, so it must never be cached to disk
            # by an intermediary or the browser.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/healthz":
            self.send_json(200, {"status": "ok"})
            return

        if parsed.path == "/api/macro/status":
            if not self.authorized():
                self.reject_unauthorized()
                return
            self.send_json(200, get_system_status())
            return

        # No fallthrough to do_POST. GET must stay side-effect free, otherwise a
        # plain image or link on any page could fire a macro.
        self.send_json(404, {"error": "unknown endpoint (macros are POST-only)"})

    def do_POST(self):
        if not self.authorized():
            self.reject_unauthorized()
            return

        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/api/macro/probe":
            execute_async_action([python_exe(), os.path.join(SCRIPTS_DIR, "test_pipeline_trigger.py")])
            self.send_json(200, {"macro": "probe", "status": "dispatched"})

        elif path == "/api/macro/heal":
            execute_async_action([python_exe(), os.path.join(SCRIPTS_DIR, "pipeline_stagnation_healer.py"), "--once"])
            self.send_json(200, {"macro": "healer_sweep", "status": "executed"})

        elif path == "/api/macro/silence":
            raw = params.get("minutes", ["60"])[0]
            try:
                mins = int(raw)
            except (TypeError, ValueError):
                self.send_json(400, {"error": "minutes must be an integer"})
                return
            if not 1 <= mins <= 1440:
                self.send_json(400, {"error": "minutes must be between 1 and 1440"})
                return

            execute_async_action([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", os.path.join(SCRIPTS_DIR, "manage_alert_silences.ps1"),
                "-Action", "create", "-DurationMinutes", str(mins)
            ])
            self.send_json(200, {"macro": "silence", "duration_minutes": mins, "status": "created"})

        elif path == "/api/macro/restart-daemons":
            execute_async_action([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", os.path.join(SCRIPTS_DIR, "manage_all_services.ps1"),
                "-Action", "restart"
            ])
            self.send_json(200, {"macro": "restart_daemons", "status": "restarting_all"})

        elif path == "/api/macro/backup":
            execute_async_action([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", os.path.join(SCRIPTS_DIR, "backup_disaster_recovery.ps1")
            ])
            self.send_json(200, {"macro": "backup", "status": "snapshot_started"})

        elif path == "/api/macro/health":
            execute_async_action([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", os.path.join(SCRIPTS_DIR, "verify_pipeline_health.ps1")
            ])
            self.send_json(200, {"macro": "health_audit", "status": "dispatched"})

        elif path == "/api/macro/open/logs":
            execute_async_action([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", os.path.join(SCRIPTS_DIR, "tail_logs.ps1"),
                "-Service", "all", "-NoWait"
            ])
            self.send_json(200, {"macro": "tail_logs", "status": "dispatched"})

        else:
            self.send_json(404, {"error": "Unknown macro endpoint"})

    def log_message(self, format, *args):
        return


def main():
    global AUTH_TOKEN, REQUIRE_TOKEN

    parser = argparse.ArgumentParser(description="Hybrid 1.0 Hardware Macro control server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--allow-lan", action="store_true",
                        help="Bind 0.0.0.0 so a phone or tablet can reach the deck. Requires a token.")
    parser.add_argument("--no-token", action="store_true",
                        help="Disable token auth. Refused when --allow-lan is set.")
    args = parser.parse_args()

    if args.allow_lan and args.no_token:
        print("[FATAL] --no-token cannot be combined with --allow-lan: that would expose")
        print("        daemon restart and backup macros to anyone on the network.")
        sys.exit(1)

    bind_addr = "0.0.0.0" if args.allow_lan else "127.0.0.1"
    REQUIRE_TOKEN = not args.no_token

    if REQUIRE_TOKEN:
        AUTH_TOKEN = os.environ.get("HYBRID_MACRO_TOKEN") or secrets.token_urlsafe(24)

    print("================================================================")
    print("HYBRID 1.0 - HARDWARE MACRO & STREAM DECK CONTROL SERVER")
    print(f"Bind address  : {bind_addr}:{args.port}")
    print(f"Touch UI URL  : http://127.0.0.1:{args.port}/")
    print(f"Token auth    : {'enabled' if REQUIRE_TOKEN else 'DISABLED'}")

    if REQUIRE_TOKEN:
        if os.environ.get("HYBRID_MACRO_TOKEN"):
            print("Token source  : HYBRID_MACRO_TOKEN environment variable")
        else:
            print("Token source  : generated for this run")
            print(f"Token         : {AUTH_TOKEN}")
            print("                Set HYBRID_MACRO_TOKEN to pin it across restarts,")
            print("                which Stream Deck needs so keys keep working.")

    if args.allow_lan:
        print()
        print("[WARNING] Bound to all interfaces. Anyone who can reach this port and")
        print("          holds the token can restart daemons and trigger backups.")

    print("================================================================")

    HTTPServer((bind_addr, args.port), MacroHandler).serve_forever()


if __name__ == "__main__":
    main()
