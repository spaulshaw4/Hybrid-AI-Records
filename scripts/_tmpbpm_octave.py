import collections
import multiprocessing as mp
import os
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scripts.validate_bpm_estimator import ground_truth  # noqa: E402

FACTORS = (0.25, 1 / 3, 0.5, 2 / 3, 1.0, 1.5, 2.0, 3.0, 4.0)
NAMES = ("1/4", "1/3", "1/2", "2/3", "1", "3/2", "2", "3", "4")


def one(path):
    from dsp.tempo_estimator import estimate_tempo

    try:
        import soundfile as sf

        data, sr = sf.read(path, always_2d=True, dtype="float64")
        return estimate_tempo(data, int(sr))
    except Exception:
        return 0.0, 0.0


if __name__ == "__main__":
    mp.freeze_support()
    rows = ground_truth("dev", 600, 20251003)
    with mp.Pool(6) as p:
        res = p.map(one, [r[0] for r in rows], chunksize=16)
    cnt = collections.Counter()
    truths = collections.Counter()
    for (path, truth, _old), (bpm, conf) in zip(rows, res):
        if bpm <= 0:
            cnt["none"] += 1
            continue
        errs = [abs(bpm * f - truth) / truth for f in FACTORS]
        i = int(np.argmin(errs))
        if errs[i] > 0.06:
            cnt["miss"] += 1
        else:
            cnt[NAMES[i]] += 1
            truths[NAMES[i]] += truth
    print(sorted(cnt.items(), key=lambda kv: -kv[1]))
    for k, v in cnt.items():
        if k in NAMES:
            print(k, v, "mean truth", round(truths[k] / v, 1))
    est = np.array([r[0] for r in res])
    print("est bpm pct", np.percentile(est[est > 0], [5, 25, 50, 75, 95]).round(1))
