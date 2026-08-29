"""
Shows that genre profiles change QC verdicts where a single threshold set is wrong.

Two cases matter:
  * A wide ambient master, phase ~0.20. Legitimate for the genre, but the
    default 0.25 floor fails it.
  * A wide rap master, phase ~0.45. Passes the default floor, but rap wants
    0.65 or above, so it should fail.
"""

import os
import sys
import shutil
import tempfile

import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from hybrid_dsp import write_wav_float32
from audio_qc_analyzer import analyze_master_qc, resolve_compliance

SR = 44100


def make_master(path, phase_offset, amp=0.5, seconds=4.0):
    """Two partials with an L/R phase offset, which sets the correlation."""
    t = np.arange(int(SR * seconds)) / SR
    l = amp * (np.sin(2 * np.pi * 220 * t) + 0.4 * np.sin(2 * np.pi * 1400 * t))
    r = amp * (np.sin(2 * np.pi * 220 * t + phase_offset)
               + 0.4 * np.sin(2 * np.pi * 1400 * t + phase_offset * 1.6))
    write_wav_float32(path, np.column_stack((l, r)).astype(np.float32), SR,
                      target_bit_depth=16)


def verdict(path, genre):
    profile, resolved = resolve_compliance(genre)
    rep = analyze_master_qc(
        path,
        target_lufs_min=profile["lufs_min"],
        target_lufs_max=profile["lufs_max"],
        true_peak_ceiling=profile["true_peak_ceiling"],
        phase_min=profile["phase_min"],
        phase_max=profile["phase_max"],
        dc_limit=profile["dc_limit"],
        report_out=os.path.splitext(path)[0] + f"_{resolved.split()[0]}.json",
    )
    return rep, resolved, profile


def main():
    tmp = tempfile.mkdtemp(prefix="genre_qc_")
    try:
        wide = os.path.join(tmp, "wide_master.wav")
        make_master(wide, phase_offset=1.15)

        mid = os.path.join(tmp, "mid_master.wav")
        make_master(mid, phase_offset=0.62)

        print("Same file, different compliance profile")
        print()

        rows = []
        for label, path, genres in (
            ("wide master", wide, ("default", "space_trippy", "rap")),
            ("mid-width master", mid, ("default", "rap", "distorted_rock")),
        ):
            print(f"  {label}")
            for g in genres:
                rep, resolved, profile = verdict(path, g)
                m = rep["metrics"]
                c = rep["compliance"]
                rows.append((label, g, m["stereo_phase_correlation"],
                             profile["phase_min"], c["phase_compatibility_met"],
                             c["overall_qc_passed"]))
                print(f"    {g:<14} phase {m['stereo_phase_correlation']:>6.3f}"
                      f"  floor {profile['phase_min']:<5}"
                      f"  phase {'PASS' if c['phase_compatibility_met'] else 'FAIL'}"
                      f"  overall {'PASS' if c['overall_qc_passed'] else 'FAIL'}")
            print()

        print("=" * 70)
        print("Verdicts that differ purely because of the profile:")
        by_file = {}
        for label, g, phase, floor, phase_ok, overall in rows:
            by_file.setdefault(label, []).append((g, overall))

        divergent = 0
        for label, results in by_file.items():
            outcomes = {o for _, o in results}
            if len(outcomes) > 1:
                divergent += 1
                detail = ", ".join(f"{g}={'PASS' if o else 'FAIL'}" for g, o in results)
                print(f"  {label}: {detail}")

        print()
        if divergent:
            print(f"{divergent} file(s) changed verdict with genre, which is the point:")
            print("  a fixed threshold set would have been wrong for at least one of them.")
            return 0

        print("No divergence, profiles had no effect on these fixtures.")
        return 1

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
