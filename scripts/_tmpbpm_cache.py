import multiprocessing as mp
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scripts.validate_bpm_estimator import ground_truth  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "_tmpbpm_env.pkl")


def one(path):
    from dsp.tempo_estimator import TARGET_SR, _resample, _to_mono, onset_envelope

    try:
        import soundfile as sf

        data, sr = sf.read(path, always_2d=True, dtype="float64")
        mono = _resample(_to_mono(data), int(sr), TARGET_SR)
        return onset_envelope(mono, TARGET_SR).astype(np.float32)
    except Exception:
        return None


if __name__ == "__main__":
    mp.freeze_support()
    split = sys.argv[1] if len(sys.argv) > 1 else "dev"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
    rows = ground_truth(split, n, 20251003)
    with mp.Pool(6) as p:
        envs = p.map(one, [r[0] for r in rows], chunksize=16)
    keep = [(r[0], r[1], r[2], e) for r, e in zip(rows, envs) if e is not None]
    with open(OUT if split == "dev" else OUT.replace(".pkl", f"_{split}.pkl"), "wb") as fh:
        pickle.dump(keep, fh)
    print("cached", len(keep), split)
