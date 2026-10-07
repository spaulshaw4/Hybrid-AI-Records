"""Block unattended slicer, stager, and snap-slice entry points.

Set HYBRID_SLICER_LAUNCH=1 to run one of those scripts on purpose.
The guard does not delete training data, catalogs, or masters.
"""
from __future__ import annotations

import os
import time


def slicer_launch_blocked() -> bool:
    return os.environ.get("HYBRID_SLICER_LAUNCH") != "1"


def refuse_unattended_launcher(idle: bool = False) -> None:
    if not slicer_launch_blocked():
        return
    print("[DISABLED] Slicer launcher is off. No files were cut, moved, or deleted.")
    if idle:
        # NSSM restarts a process that exits. Stay idle so the paused watchdog
        # cannot resume cutting if the service is continued.
        while True:
            time.sleep(3600)
    raise SystemExit(0)
