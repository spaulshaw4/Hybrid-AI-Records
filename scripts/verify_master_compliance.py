import os
import sys
import glob
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


def measure_compliance(master_path: str):
    if not os.path.exists(master_path):
        print(f"[ERROR] Master deliverable not found: {master_path}", file=sys.stderr)
        sys.exit(1)

    data, sr = sf.read(master_path, always_2d=True)
    num_samples, num_channels = data.shape

    oversampled = resample_poly(data, 4, 1, axis=0)
    true_peak_linear = np.max(np.abs(oversampled))
    true_peak_dbtp = 20.0 * np.log10(true_peak_linear + 1e-12)

    left = data[:, 0]
    right = data[:, 1] if num_channels > 1 else data[:, 0]
    l_norm = left - np.mean(left)
    r_norm = right - np.mean(right)
    denom = (np.sqrt(np.sum(l_norm**2)) * np.sqrt(np.sum(r_norm**2))) + 1e-12
    phase_corr = float(np.sum(l_norm * r_norm) / denom)

    mono = np.mean(data, axis=1)
    rms_dbfs = 20.0 * np.log10(np.sqrt(np.mean(mono**2)) + 1e-12)

    tp_pass = true_peak_dbtp <= -0.50
    phase_pass = phase_corr >= 0.80

    print("==================================================")
    print("           MASTER QC VERIFICATION REPORT          ")
    print("==================================================")
    print(f" Target File:       {os.path.basename(master_path)}")
    print(f" Sample Rate:       {sr} Hz (24-bit PCM)")
    print(f" Duration:          {num_samples / sr:.2f} seconds")
    print("--------------------------------------------------")
    print(f" True Peak:         {true_peak_dbtp:.2f} dBTP  [{'PASS' if tp_pass else 'FAIL'} (Limit <= -0.50)]")
    print(f" Phase Correlation: {phase_corr:.3f}       [{'PASS' if phase_pass else 'FAIL'} (Min >= 0.80)]")
    print(f" Integrated RMS:    {rms_dbfs:.2f} dBFS")
    print("==================================================")

    if tp_pass and phase_pass:
        print("[STATUS: PASSED] Master meets streaming delivery standards.")
        return 0

    print("[STATUS: REJECTED] Master violated QC safety gates.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(measure_compliance(sys.argv[1]))

    releases = glob.glob(r"D:\MusicDatasets\releases\*\master_output.wav")
    if not releases:
        print("[ERROR] No master files found in releases directory.", file=sys.stderr)
        sys.exit(1)
    latest_master = max(releases, key=os.path.getmtime)
    sys.exit(measure_compliance(latest_master))
