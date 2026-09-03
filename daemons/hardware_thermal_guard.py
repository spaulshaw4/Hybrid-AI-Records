"""Hardware thermal guard. Default: log + throttle flag. No NSSM pause.

``--pause-daemon`` is opt-in and will pause HybridAudioDaemon. That is a
production outage — do not use it as the default path.

Workers honor ``D:\\MusicDatasets\\config\\throttle.json`` (see
``master_queue_worker``). ``--once`` runs a single probe and exits.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

BASE_DIR = os.environ.get("MUSICDATASETS_ROOT", r"D:\MusicDatasets")
THROTTLE_PATH = os.environ.get(
    "HYBRID_THROTTLE_FILE",
    os.path.join(BASE_DIR, "config", "throttle.json"),
)
WARN_C = float(os.environ.get("HYBRID_THERMAL_WARN_C", "85"))
CRITICAL_C = float(os.environ.get("HYBRID_THERMAL_CRITICAL_C", "95"))
INTERVAL_SEC = float(os.environ.get("HYBRID_THERMAL_INTERVAL", "30"))
DAEMON_NAME = os.environ.get("HYBRID_AUDIO_DAEMON", "HybridAudioDaemon")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_temperatures_c() -> tuple[list[float], str]:
    """Return (celsius readings, source). Empty list if unavailable."""
    try:
        import psutil  # type: ignore
    except ImportError:
        return [], "psutil_missing"

    probe = getattr(psutil, "sensors_temperatures", None)
    if probe is None:
        return [], "psutil_no_sensors"
    try:
        sensors = probe()
    except Exception as exc:
        return [], f"psutil_error:{exc}"
    if not sensors:
        return [], "psutil_no_sensors"

    readings: list[float] = []
    for _name, entries in sensors.items():
        for entry in entries:
            current = getattr(entry, "current", None)
            if current is None:
                continue
            try:
                value = float(current)
            except (TypeError, ValueError):
                continue
            if 0.0 < value < 150.0:
                readings.append(value)
    if not readings:
        return [], "psutil_empty"
    return readings, "psutil"


def evaluate_thermal(celsius: float | None, warn_c: float = WARN_C, critical_c: float = CRITICAL_C) -> dict:
    if celsius is None:
        return {
            "throttled": False,
            "reason": "no_sensor",
            "celsius": None,
            "updated_at": utc_now(),
        }
    if celsius >= critical_c:
        return {
            "throttled": True,
            "reason": "critical",
            "celsius": celsius,
            "updated_at": utc_now(),
        }
    if celsius >= warn_c:
        return {
            "throttled": True,
            "reason": "warn",
            "celsius": celsius,
            "updated_at": utc_now(),
        }
    return {
        "throttled": False,
        "reason": "ok",
        "celsius": celsius,
        "updated_at": utc_now(),
    }


def write_throttle_flag(payload: dict, path: str = THROTTLE_PATH) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def pause_audio_daemon() -> str:
    nssm = shutil_which("nssm")
    if not nssm:
        return "nssm_not_on_path"
    result = subprocess.run([nssm, "pause", DAEMON_NAME], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        return f"nssm_pause_failed:{result.returncode}"
    return "paused"


def shutil_which(name: str) -> str | None:
    from shutil import which

    return which(name)


def probe_once(*, pause_daemon: bool, celsius_override: float | None) -> dict:
    if celsius_override is not None:
        readings, source = [float(celsius_override)], "override"
    else:
        readings, source = read_temperatures_c()
    hottest = max(readings) if readings else None
    payload = evaluate_thermal(hottest)
    payload["source"] = source
    payload["readings"] = readings
    try:
        write_throttle_flag(payload)
    except OSError as exc:
        print(f"[THERMAL] could not write {THROTTLE_PATH}: {exc}")
    print(
        f"[THERMAL] source={source} celsius={hottest} throttled={payload['throttled']} "
        f"reason={payload['reason']} flag={THROTTLE_PATH}"
    )
    if source == "psutil_missing":
        print("[THERMAL] psutil is not installed; wrote a no_sensor throttle flag and skipped hardware probe.")
    elif source == "psutil_no_sensors":
        print("[THERMAL] psutil has no temperature sensors on this host; throttle flag is not armed.")
    if payload["throttled"] and pause_daemon:
        print(f"[THERMAL] --pause-daemon requested: {pause_audio_daemon()}")
    elif pause_daemon and not payload["throttled"]:
        print("[THERMAL] --pause-daemon set but temperatures are under threshold; daemon left running.")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Write a thermal throttle flag. Does not pause NSSM by default.")
    parser.add_argument("--once", action="store_true", help="Probe once and exit")
    parser.add_argument("--pause-daemon", action="store_true", help="Opt-in NSSM pause of HybridAudioDaemon when hot")
    parser.add_argument("--celsius", type=float, help="Override probe (tests / operators)")
    parser.add_argument("--interval", type=float, default=INTERVAL_SEC)
    args = parser.parse_args()

    if args.once:
        probe_once(pause_daemon=args.pause_daemon, celsius_override=args.celsius)
        return 0

    print("[*] Hardware thermal guard active. Default action is throttle.json, not nssm pause.")
    while True:
        probe_once(pause_daemon=args.pause_daemon, celsius_override=args.celsius)
        time.sleep(max(5.0, float(args.interval)))


if __name__ == "__main__":
    sys.exit(main())
