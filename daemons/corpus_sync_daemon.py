"""Thin entry so `python daemons/corpus_sync_daemon.py` uses the scripts copy."""
from __future__ import annotations

import os
import runpy
import sys

TARGET = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "corpus_sync_daemon.py")
if not os.path.isfile(TARGET):
    TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts", "corpus_sync_daemon.py")
sys.argv[0] = TARGET
runpy.run_path(TARGET, run_name="__main__")
