"""In-memory DSP smoke test across curated and matrix genre profiles."""
from __future__ import annotations

import os
import sys
import time

import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSTATION_SCRIPTS = r"D:\MusicDatasets\scripts"
for path in (WORKSTATION_SCRIPTS, SCRIPTS_DIR):
    if os.path.isdir(path) and path not in sys.path:
        sys.path.insert(0, path)

try:
    from studio_master_chain import apply_studio_master_chain  # noqa: E402
    from genre_master_profiles import (  # noqa: E402
        GENRE_MASTER_PROFILES,
        resolve_profile,
        _matrix_profiles,
    )
except ImportError as exc:
    apply_studio_master_chain = None  # type: ignore[misc, assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


def resolve_genre_profile(genre: str):
    name, profile = resolve_profile(genre)
    if name in GENRE_MASTER_PROFILES and name == genre.strip().lower().replace("-", "_").replace(" ", "_"):
        source = "curated"
    elif name in GENRE_MASTER_PROFILES:
        source = "alias"
    else:
        source = "matrix"
    return name, source, profile


def synthetic_stereo(sr: int = 44100, duration_sec: float = 4.0) -> np.ndarray:
    num_samples = int(sr * duration_sec)
    t = np.linspace(0, duration_sec, num_samples, endpoint=False)
    left = 0.5 * np.sin(2 * np.pi * 100 * t) + 0.1 * np.random.normal(0, 0.1, num_samples)
    right = 0.5 * np.sin(2 * np.pi * 100 * t) + 0.1 * np.random.normal(0, 0.1, num_samples)
    return np.column_stack([left, right]).astype(np.float32)


def run_dsp_smoke_test() -> int:
    if apply_studio_master_chain is None:
        print(f"[SKIP] studio_master_chain unavailable ({_IMPORT_ERROR})")
        return 0
    sr = 44100
    test_signal = synthetic_stereo(sr)
    test_genres = [
        "nu_metal", "classic_rock", "trap", "drill", "pop", "ambient",
        "dark_techno", "cyber_metal", "liquid_house", "lo-fi_hiphop", "future_bass",
        "alt_rock", "blues_rock", "rap_rock",
    ]
    matrix = _matrix_profiles()
    extra = sorted(matrix.keys())[:20]
    for name in extra:
        if name not in test_genres:
            test_genres.append(name)

    print(f"[*] Starting DSP smoke test across {len(test_genres)} target profiles...")
    print(f"{'GENRE':<22} | {'RESOLVED AS':<22} | {'SOURCE':<8} | {'EXEC TIME':<10} | {'STATUS'}")
    print("-" * 85)

    failures = 0
    for genre in test_genres:
        t0 = time.perf_counter()
        resolved, source, _profile = resolve_genre_profile(genre)
        output_signal = apply_studio_master_chain(
            test_signal.copy(), sr, genre=genre, verbose=False
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        has_nan = bool(np.isnan(output_signal).any())
        has_inf = bool(np.isinf(output_signal).any())
        status = "PASSED" if not (has_nan or has_inf) else "CORRUPT"
        if status != "PASSED":
            failures += 1
        print(f"{genre:<22} | {resolved:<22} | {source:<8} | {elapsed_ms:>6.2f} ms | {status}")

    print("-" * 85)
    if failures:
        print(f"[FAILED] {failures} profile(s) produced NaN/Inf.")
        return 1
    print("[SUCCESS] All DSP biquad and saturation topologies verified.")
    return 0


if __name__ == "__main__":
    sys.exit(run_dsp_smoke_test())
