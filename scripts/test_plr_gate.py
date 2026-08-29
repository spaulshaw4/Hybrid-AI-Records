"""Confirms the PLR gate produces different verdicts per genre profile."""

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


def blend_signal(mix, seconds=4.0, seed=3):
    """
    mix 0.0 is a dense limited bed, 1.0 is sparse transients over near-silence.
    PLR rises monotonically with mix, which is what makes bisection valid.
    """
    rng = np.random.default_rng(seed)
    n = int(SR * seconds)

    dense = np.tanh(rng.standard_normal((n, 2)) * 3.0) * 0.9

    sparse = rng.standard_normal((n, 2)) * 0.02
    for hit in range(0, n, SR // 2):
        L = min(3000, n - hit)
        sparse[hit:hit + L] += (np.exp(-np.arange(L) / 400.0) * 0.8)[:, None]

    out = (1.0 - mix) * dense + mix * sparse
    peak = np.max(np.abs(out))
    if peak > 0:
        out = out / peak * 0.85
    return out.astype(np.float32)


def measure_plr(signal):
    from audio_qc_analyzer import compute_integrated_lufs, compute_true_peak_dbtp
    sig = signal.astype(np.float64)
    lufs, _, _ = compute_integrated_lufs(sig, SR)
    tp, _ = compute_true_peak_dbtp(sig, SR)
    return tp - lufs


def build_fixture_at_plr(path, target_plr, tolerance=0.4, iterations=18):
    """Bisect the blend until measured PLR is within tolerance of target."""
    lo, hi = 0.0, 1.0
    best = None

    for _ in range(iterations):
        mid = (lo + hi) / 2.0
        sig = blend_signal(mid)
        plr = measure_plr(sig)

        if best is None or abs(plr - target_plr) < abs(best[1] - target_plr):
            best = (sig, plr, mid)

        if abs(plr - target_plr) <= tolerance:
            break
        if plr < target_plr:
            lo = mid
        else:
            hi = mid

    sig, plr, mix = best
    write_wav_float32(path, sig, SR, target_bit_depth=16)
    print(f"  built {os.path.basename(path)}: PLR {plr:.2f} dB "
          f"(target {target_plr}, blend {mix:.4f})")
    return plr


def run(path, genre, tmp):
    profile, name = resolve_compliance(genre)
    rep = analyze_master_qc(
        path,
        target_lufs_min=profile["lufs_min"],
        target_lufs_max=profile["lufs_max"],
        true_peak_ceiling=profile["true_peak_ceiling"],
        phase_min=profile["phase_min"],
        phase_max=profile["phase_max"],
        dc_limit=profile["dc_limit"],
        crest_min=profile["crest_min"],
        crest_max=profile["crest_max"],
        report_out=os.path.join(tmp, f"{genre}.json"),
    )
    return rep, profile


def main():
    tmp = tempfile.mkdtemp(prefix="plr_")
    try:
        # Extreme fixtures prove nothing: a PLR of 2 or 24 fails every band, so
        # no verdict can diverge. Blend a dense bed with sparse transients and
        # bisect on the mix until PLR lands inside a real genre window.
        dense_path = os.path.join(tmp, "loud.wav")
        sparse_path = os.path.join(tmp, "dynamic.wav")

        build_fixture_at_plr(dense_path, target_plr=7.0)
        build_fixture_at_plr(sparse_path, target_plr=12.0)

        results = {}

        for label, path in (("loud master (PLR ~7)", dense_path),
                            ("dynamic master (PLR ~12)", sparse_path)):
            print(f"  {label}")
            verdicts = []
            for genre in ("rap", "distorted_rock", "space_trippy"):
                rep, profile = run(path, genre, tmp)
                m, c = rep["metrics"], rep["compliance"]
                verdicts.append((genre, c["plr_in_band"]))
                print(f"    {genre:<15} PLR {m['plr_db']:>7.2f} dB"
                      f"  band {profile['crest_min']}-{profile['crest_max']}"
                      f"  -> {'PASS' if c['plr_in_band'] else 'FAIL'}")
            results[label] = verdicts
            print()

        print("=" * 66)
        divergent = 0
        for label, verdicts in results.items():
            outcomes = {v for _, v in verdicts}
            if len(outcomes) > 1:
                divergent += 1
                detail = ", ".join(f"{g}={'PASS' if v else 'FAIL'}" for g, v in verdicts)
                print(f"  {label}: {detail}")

        print()
        print(f"{divergent}/{len(results)} fixture(s) changed PLR verdict by genre.")
        print("A single dynamics band would have misjudged at least one of them.")

        return 0 if divergent else 1

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
