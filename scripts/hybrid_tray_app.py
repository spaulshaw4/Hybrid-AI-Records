# D:\MusicDatasets\scripts\hybrid_tray_app.py
import os
import sys
import time
import threading
import subprocess
import webbrowser

from PIL import Image, ImageDraw
import pystray
from pystray import MenuItem as item, Menu

SERVICES = [
    "HybridPrometheusExporterDaemon",
    "HybridPrometheusDaemon",
    "HybridAlertmanagerDaemon",
    "HybridStorageGuardDaemon",
    "HybridStagnationHealerDaemon",
    "HybridWatchdogDaemon",
    "HybridAudioDaemon"
]

SERVICE_STATES = {svc: "UNKNOWN" for svc in SERVICES}
APP_RUNNING = True

BASE_DIR = r"D:\MusicDatasets"
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")
BACKUP_DIR = os.path.join(BASE_DIR, "archive", "backups")

# The tray app is itself launched by a real interpreter (install_tray_startup.ps1
# resolves one via resolve_python.ps1), so sys.executable is a reliable handle.
# A bare "python" would hit the Microsoft Store alias stub on this machine.
PYTHON_EXE = sys.executable


def check_service_status(service_name: str) -> str:
    try:
        res = subprocess.run(["sc.exe", "query", service_name], capture_output=True, text=True, timeout=3)
        stdout = res.stdout.upper()

        if "STATE" in stdout and "RUNNING" in stdout:
            return "RUNNING"
        elif "STATE" in stdout and "STOPPED" in stdout:
            return "STOPPED"
        elif "STATE" in stdout and "START_PENDING" in stdout:
            return "STARTING"
        elif "STATE" in stdout and "STOP_PENDING" in stdout:
            return "STOPPING"
        elif "1060" in stdout or "DOES NOT EXIST" in stdout:
            return "NOT_FOUND"
        return "UNKNOWN"
    except Exception:
        return "ERROR"


def create_tray_icon(status_mode: str) -> Image.Image:
    img = Image.new("RGBA", (64, 64), color=(0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background plate
    draw.rounded_rectangle([2, 2, 62, 62], radius=14, fill=(24, 24, 27, 255), outline=(63, 63, 70, 255), width=2)

    # Status indicator color
    if status_mode == "OK":
        color = (34, 197, 94, 255)    # Emerald Green
    elif status_mode == "WARN":
        color = (234, 179, 8, 255)    # Amber Yellow
    else:
        color = (239, 68, 68, 255)    # Rose Red

    draw.ellipse([20, 20, 44, 44], fill=color)
    draw.ellipse([26, 26, 38, 38], fill=(255, 255, 255, 200))

    return img


def run_elevated_service_action(action: str):
    script_path = os.path.join(SCRIPTS_DIR, "manage_all_services.ps1")
    ps_cmd = f"Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -NoExit -File \"{script_path}\" -Action {action}'"
    subprocess.Popen(["powershell.exe", "-NoProfile", "-Command", ps_cmd])


def launch_tool(cmd_list: list[str]):
    subprocess.Popen(cmd_list, shell=True)


def open_url(url: str):
    webbrowser.open(url)


def launch_db_replay(dry_run: bool = False, specific_table: str = None):
    replay_script = os.path.join(SCRIPTS_DIR, "replay_database_snapshots.py")
    backup_dir_escaped = BACKUP_DIR.replace("\\", "\\\\")

    replay_cmd = f"& '{PYTHON_EXE}' '{replay_script}' --source $latest.FullName"
    if dry_run:
        replay_cmd += " --dry-run"
    if specific_table:
        replay_cmd += f" --table {specific_table}"

    ps_commands = [
        "$ErrorActionPreference = 'Continue'",
        f"$latest = Get-ChildItem -Path '{BACKUP_DIR}' -Filter 'hybrid10_backup_*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1",
        f"if (-not $latest) {{ Write-Host '[ERROR] No backup archive found in {backup_dir_escaped}' -ForegroundColor Red; return }}",
        "Write-Host '[REPLAY TARGET]' $latest.FullName -ForegroundColor Cyan",
        replay_cmd
    ]

    combined_cmd = "; ".join(ps_commands)
    ps_args = f"Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -ExecutionPolicy Bypass -Command \"{combined_cmd}\"'"
    subprocess.Popen(["powershell.exe", "-NoProfile", "-Command", ps_args])


def run_backup_snapshot():
    backup_script = os.path.join(SCRIPTS_DIR, "backup_disaster_recovery.ps1")
    ps_cmd = f"Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -NoExit -File \"{backup_script}\" -RetentionDays 14'"
    subprocess.Popen(["powershell.exe", "-NoProfile", "-Command", ps_cmd])


def update_loop(icon: pystray.Icon):
    global SERVICE_STATES

    while APP_RUNNING:
        running_count = 0

        for svc in SERVICES:
            st = check_service_status(svc)
            SERVICE_STATES[svc] = st
            if st == "RUNNING":
                running_count += 1

        total = len(SERVICES)

        if running_count == total:
            status_mode = "OK"
            tooltip = f"Hybrid 1.0: All {total} Services Active"
        elif running_count > 0:
            status_mode = "WARN"
            tooltip = f"Hybrid 1.0: {running_count}/{total} Running"
        else:
            status_mode = "CRIT"
            tooltip = f"Hybrid 1.0: ALL STOPPED (0/{total})"

        icon.icon = create_tray_icon(status_mode)
        icon.title = tooltip

        time.sleep(5)


def get_status_header(item) -> str:
    running = sum(1 for s in SERVICE_STATES.values() if s == "RUNNING")
    return f"Status: {running}/{len(SERVICES)} Daemons Active"


def get_service_item_label(svc_name: str):
    def _label(item) -> str:
        st = SERVICE_STATES.get(svc_name, "QUERYING")
        short_name = svc_name.replace("Hybrid", "").replace("Daemon", "")
        icon_tag = "●" if st == "RUNNING" else "○"
        return f"  {icon_tag} {short_name}: {st}"
    return _label


def build_menu():
    service_items = [
        item(get_service_item_label(s), lambda: None, enabled=False) for s in SERVICES
    ]

    replay_submenu = Menu(
        item("Dry Run (Preview Latest Archive)", lambda: launch_db_replay(dry_run=True)),
        item("Live Replay: All Tables", lambda: launch_db_replay(dry_run=False)),
        item("Live Replay: user_vaults Only", lambda: launch_db_replay(dry_run=False, specific_table="user_vaults")),
        item("Live Replay: telemetry_logs Only", lambda: launch_db_replay(dry_run=False, specific_table="pipeline_telemetry_logs"))
    )

    return Menu(
        item(get_status_header, lambda: None, enabled=False),
        Menu.SEPARATOR,
        *service_items,
        Menu.SEPARATOR,
        item("Restart All Daemons", lambda: run_elevated_service_action("restart")),
        item("Start All Daemons", lambda: run_elevated_service_action("start")),
        item("Stop All Daemons", lambda: run_elevated_service_action("stop")),
        Menu.SEPARATOR,
        item("Create DR Backup Snapshot", lambda: run_backup_snapshot()),
        item("Replay Database Snapshots", replay_submenu),
        Menu.SEPARATOR,
        item("Open Telemetry Dashboard", lambda: open_url("http://localhost:3000/telemetry")),
        item("Open Prometheus (9090)", lambda: open_url("http://localhost:9090")),
        item("Open Alertmanager (9093)", lambda: open_url("http://localhost:9093")),
        Menu.SEPARATOR,
        item("Control Center Shell", lambda: launch_tool(["start", os.path.join(SCRIPTS_DIR, "hybrid_control_center.bat")])),
        item("Stream Live Logs", lambda: launch_tool(["start", "powershell", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", os.path.join(SCRIPTS_DIR, "tail_logs.ps1"), "-Service", "all"])),
        item("Run Health Diagnostics", lambda: launch_tool(["start", "powershell", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", os.path.join(SCRIPTS_DIR, "verify_pipeline_health.ps1")])),
        Menu.SEPARATOR,
        item("Exit Tray Controller", on_exit)
    )


def on_exit(icon: pystray.Icon, item):
    global APP_RUNNING
    APP_RUNNING = False
    icon.stop()


def main():
    icon = pystray.Icon(
        name="Hybrid1.0Control",
        icon=create_tray_icon("WARN"),
        title="Hybrid 1.0 - Initializing...",
        menu=build_menu()
    )

    t = threading.Thread(target=update_loop, args=(icon,), daemon=True)
    t.start()

    icon.run()


if __name__ == "__main__":
    main()
