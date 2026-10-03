import itertools
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scipy import fft as sp_fft  # noqa: E402

SR, HOP = 22050, 128
FR = SR / HOP
GRID = np.exp(np.linspace(np.log(50.0), np.log(215.0), 600))
FOLD = (0.25, 1 / 3, 0.5, 2 / 3, 1.0, 1.5, 2.0, 3.0, 4.0)


def acf(env, alpha):
    c = env - env.mean()
    n = c.size
    size = 1 << (2 * n - 1).bit_length()
    s = sp_fft.rfft(c, size)
    r = sp_fft.irfft(s * np.conj(s), size)[:n]
    r = r / np.arange(n, 0, -1) ** alpha
    return r / r[0] if r[0] > 1e-12 else r


def interp(r, lags, maxfrac):
    f = np.floor(lags).astype(np.int64)
    fr = lags - f
    lim = int(maxfrac * r.size)
    ok = (f >= 0) & (f + 1 < min(r.size, lim))
    out = np.zeros(lags.shape)
    out[ok] = r[f[ok]] * (1 - fr[ok]) + r[f[ok] + 1] * fr[ok]
    return out


def score(env, p):
    r = acf(env, p["alpha"])
    base = FR * 60.0 / GRID
    s = np.zeros(GRID.size)
    for k in range(1, p["nharm"] + 1):
        s += (p["decay"] ** (k - 1)) * interp(r, base * k, p["maxfrac"])
    for m in (0.5, 1.5, 2.5):
        s -= p["woff"] * interp(r, base * m, p["maxfrac"])
    for m in (2 / 3, 4 / 3):
        s -= p["wthird"] * interp(r, base * m, p["maxfrac"])
    prior = np.exp(-0.5 * (np.log2(GRID / p["center"]) / p["sigma"]) ** 2)
    return s * prior


def evaluate(data, p):
    est = []
    for _path, _truth, _old, env in data:
        e = np.asarray(env, dtype=np.float64)
        if e.size < 8:
            est.append(0.0)
            continue
        sc = score(e, p)
        i = int(np.argmax(sc))
        if sc[i] <= 0:
            est.append(0.0)
            continue
        est.append(GRID[i])
    est = np.array(est)
    truth = np.array([d[1] for d in data], dtype=np.float64)
    ok = est > 0
    rel = np.full(est.shape, np.inf)
    rel[ok] = np.abs(est[ok] - truth[ok]) / truth[ok]
    folded = np.array([
        min(abs(e * f - t) / t for f in FOLD) if e > 0 else np.inf for e, t in zip(est, truth)
    ])
    n = est.size
    return {
        "w3": 100 * (rel <= 0.03).sum() / n,
        "w6": 100 * (rel <= 0.06).sum() / n,
        "f6": 100 * (folded <= 0.06).sum() / n,
        "med": 100 * np.median(rel[np.isfinite(rel)]),
    }


if __name__ == "__main__":
    with open(os.path.join(os.path.dirname(__file__), "_tmpbpm_env.pkl"), "rb") as fh:
        data = pickle.load(fh)
    base = dict(alpha=1.0, nharm=4, decay=0.6, maxfrac=0.75, woff=0.45,
                wthird=0.0, center=122.0, sigma=1.05)
    results = []
    for center, sigma, wthird, alpha, maxfrac in itertools.product(
        (120.0, 126.0, 130.0), (0.35, 0.45, 0.55), (0.6, 1.0, 1.5),
        (0.0, 0.5, 1.0), (0.55, 0.7)
    ):
        p = dict(base, alpha=alpha, maxfrac=maxfrac, sigma=sigma, center=center,
                 wthird=wthird, decay=1.0, woff=0.0, nharm=6)
        m = evaluate(data, p)
        results.append((m["w3"], center, sigma, wthird, alpha, maxfrac, m))
    for row in sorted(results, reverse=True)[:14]:
        print(f"c={row[1]} sig={row[2]} w3rd={row[3]} a={row[4]} mf={row[5]} -> "
              f"w3={row[6]['w3']:.1f} w6={row[6]['w6']:.1f} f6={row[6]['f6']:.1f} "
              f"med={row[6]['med']:.1f}")
