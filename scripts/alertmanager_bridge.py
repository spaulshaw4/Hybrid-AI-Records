# D:\MusicDatasets\scripts\alertmanager_bridge.py
"""
Local webhook receiver that renders Alertmanager payloads as Discord embeds.

Alertmanager posts to http://127.0.0.1:5001/webhook (see webhook_configs in
config/alertmanager.yml). This avoids baking a third-party webhook URL into the
config file, and means alerts still surface locally when DISCORD_WEBHOOK_URL is
unset - they are logged instead of silently dropped.

Bound to loopback: Alertmanager runs on the same host, and an open webhook
endpoint would let anything on the network post fake alerts.
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("ALERT_BRIDGE_PORT", 5001))
BIND_ADDR = os.environ.get("ALERT_BRIDGE_HOST", "127.0.0.1")

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")

MAX_RETRIES = 3
RETRY_DELAY_SEC = 2

SEVERITY_COLORS = {
    "critical": 15548997,   # red
    "warning": 15105570,    # amber
    "info": 3447003,        # blue
    "resolved": 5763719     # green
}


def post_with_retry(url: str, payload: dict) -> bool:
    """
    Deliver to Discord, retrying transient failures.

    A dropped critical alert is worse than a delayed one, so 5xx and timeouts are
    retried. 4xx is not: a malformed payload or revoked webhook will not fix
    itself, and retrying would just delay the log line that reveals the problem.
    """
    body = json.dumps(payload).encode("utf-8")

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Hybrid10AlertBridge/1.0"
                }
            )
            with urllib.request.urlopen(req, timeout=5):
                return True
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                print(f"[BRIDGE ERROR] Discord rejected payload ({e.code}); not retrying.")
                return False
            print(f"[BRIDGE WARN] Discord returned {e.code}, attempt {attempt}/{MAX_RETRIES}")
        except Exception as e:
            print(f"[BRIDGE WARN] Delivery attempt {attempt}/{MAX_RETRIES} failed: {e}")

        if attempt < MAX_RETRIES:
            time.sleep(RETRY_DELAY_SEC)

    print("[BRIDGE ERROR] Giving up after retries; alert not delivered.")
    return False


def send_discord_notification(alert: dict, status: str):
    labels = alert.get("labels", {}) or {}
    annotations = alert.get("annotations", {}) or {}

    severity = str(labels.get("severity", "info")).lower()
    alert_name = labels.get("alertname", "Unknown Alert")
    resolved = status == "resolved"

    description = annotations.get("description") or annotations.get("summary") or "No alert details."

    if not DISCORD_WEBHOOK_URL:
        # Still make the alert visible: this stdout goes to
        # logs/alert_bridge_stdout.log via NSSM, which tail_logs.ps1 -Service bridge follows.
        state = "RESOLVED" if resolved else "FIRING"
        print(f"[BRIDGE LOG] {state} [{severity.upper()}] {alert_name}: {description}")
        return

    color = SEVERITY_COLORS.get("resolved" if resolved else severity, SEVERITY_COLORS["info"])
    title = f"{'[RESOLVED]' if resolved else '[FIRING]'} {alert_name}"

    fields = [
        {"name": "Severity", "value": severity.upper(), "inline": True},
        {"name": "Target", "value": str(labels.get("target", "system")), "inline": True}
    ]

    if labels.get("component"):
        fields.append({"name": "Component", "value": str(labels["component"]), "inline": True})

    payload = {
        "username": "Hybrid 1.0 Telemetry Watchdog",
        "embeds": [
            {
                "title": title[:256],
                "description": description[:4096],
                "color": color,
                "fields": fields
            }
        ]
    }

    if post_with_retry(DISCORD_WEBHOOK_URL, payload):
        print(f"[BRIDGE] Delivered {'resolved' if resolved else severity} alert: {alert_name}")


class AlertHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Liveness probe so verify_pipeline_health can distinguish "listening"
        # from "registered but dead".
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/webhook":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            data = json.loads(body.decode("utf-8"))
            group_status = data.get("status", "firing")
            alerts = data.get("alerts", []) or []

            for alert in alerts:
                send_discord_notification(alert, alert.get("status", group_status))

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        except Exception as e:
            print(f"[BRIDGE ERROR] Malformed webhook payload: {e}")
            self.send_response(400)
            self.end_headers()

    def log_message(self, format, *args):
        return


def main():
    print("================================================================")
    print("HYBRID 1.0 - ALERTMANAGER NOTIFICATION BRIDGE")
    print(f"Listening      : http://{BIND_ADDR}:{PORT}/webhook")
    print(f"Health probe   : http://{BIND_ADDR}:{PORT}/healthz")
    print(f"Discord target : {'configured' if DISCORD_WEBHOOK_URL else 'NOT SET - alerts will be logged only'}")
    print("================================================================")

    server = HTTPServer((BIND_ADDR, PORT), AlertHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
