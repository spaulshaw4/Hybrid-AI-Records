import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from dsp.tempo_estimator import (  # noqa: E402
    _GRID,
    _parabolic_peak,
    tempo_salience,
)

with open(os.path.join(os.path.dirname(__file__), "_tmpbpm_env.pkl"), "rb") as fh:
    data = pickle.load(fh)

est, conf, truth = [], [], []
for _p, t, _o, env in data:
    e = np.asarray(env, dtype=np.float64)
    sc = tempo_salience(e)
    i = int(np.argmax(sc))
    peak = float(sc[i])
    spread = float(np.mean(np.abs(sc)))
    est.append(_parabolic_peak(sc, i) if peak > 0 else 0.0)
    conf.append(peak / (peak + 4.0 * spread) if spread > 1e-10 and peak > 0 else 0.0)
    truth.append(t)
est, conf, truth = np.array(est), np.array(conf), np.array(truth)
rel = np.where(est > 0, np.abs(est - truth) / truth, np.inf)
print("overall w3", round(100 * (rel <= .03).mean(), 1), "n", est.size)
print("conf pct", np.percentile(conf, [5, 25, 50, 75, 95]).round(3))
for lo in (0.0, 0.3, 0.4, 0.5, 0.6, 0.7):
    k = conf >= lo
    if k.sum() > 30:
        print(f"conf>={lo}: keep {100*k.mean():5.1f}%  w3 {100*(rel[k]<=.03).mean():5.1f}%"
              f"  med {100*np.median(rel[k][np.isfinite(rel[k])]):.2f}%")
print("distinct", len(set(np.round(est[est > 0], 1).tolist())))
