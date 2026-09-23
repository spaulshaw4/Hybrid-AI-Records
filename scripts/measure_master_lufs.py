"""Measure master.wav with pyloudnorm LUFS + sample/true peak (user brief)."""
from __future__ import annotations

import os
import sys

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

path = sys.argv[1] if len(sys.argv) > 1 else r"C:\live_web_outputs\scratch\ht_904f5296ab11\delivery\master.wav"
if not os.path.isfile(path):
    # Fall back to legacy render master if delivery not built yet.
    alt = r"C:\live_web_outputs\renders\ht_904f5296ab11\master_output.wav"
    path = alt if os.path.isfile(alt) else path

print("PATH", path)
data, rate = sf.read(path)
meter = pyln.Meter(rate)
loudness = meter.integrated_loudness(data)
peak = np.max(np.abs(data))
true_peak_dbtp = 20 * np.log10(peak) if peak > 0 else -100.0
peak_db = 20 * np.log10(peak) if peak > 0 else -100.0
print(f"Integrated Loudness: {loudness:.2f} LUFS")
print(f"Peak: {true_peak_dbtp:.2f} dBTP")
print(f"Max Peak: {peak_db:.2f} dBFS")
print(f"PASS_LUFS={abs(float(loudness) - (-14.0)) <= 0.5}")
print(f"PASS_PEAK={float(true_peak_dbtp) <= -1.0}")
