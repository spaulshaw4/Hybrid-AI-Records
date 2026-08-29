# D:\MusicDatasets\scripts\genre_quadrant_engine.py
"""
Hybrid 1.0 - 4-Quadrant Processing Matrix.

  Q1  Low-End Foundation   kick, sub, bass, 808  - mono-collapse below cutoff, punch gain
  Q2  Harmonic Mid-Body    rhythm gtr, keys, pad - tanh drive, M/S width expansion
  Q3  Top-End & Vocal Core lead vox, cymbals     - high-shelf air, presence gain
  Q4  Cylinder Master Bus  summed                - energy normalisation, soft-knee, clamp

Filtering is done in the frequency domain via rfft. For offline processing of
short slices this is exact and avoids the phase smear a naive one-pole would add
to the low band, which matters because Q1 mono-collapses it.

Stem routing
------------
Filenames are checked for role keywords first. Most of this corpus has none -
slices are named slice_<genre>_<ts>_<n>.wav or premix_00000.wav - so there is a
spectral fallback that routes on energy distribution instead.

A caveat worth stating plainly: the quadrant matrix is designed for separated
multitrack stems. FMA and MTG-Jamendo ship full mixes, so slices drawn from them
carry all three bands at once and spectral routing can only approximate a role.
Genuine per-role separation exists only in musdb18, dsd100, slakh and bass_db.
"""

import os
import sys
import argparse
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hybrid_dsp import (
    read_wav_float32,
    write_wav_float32,
    apply_dc_blocker,
    apply_soft_knee_limiter,
    dbfs_to_linear,
    linear_to_dbfs,
)

GENRE_PROFILES = {
    "heavy_alternative_rock": {
        "q1_mono_cutoff_hz": 120,
        "q1_bass_gain_db": 1.5,
        "q2_stereo_width": 1.25,
        "q2_drive": 3.5,
        "q3_vocal_boost_db": 2.0,
        "q3_air_shelf_db": 1.5,
        "q3_air_cutoff_hz": 8000,
        "q4_threshold_dbfs": -3.5,
        "q4_ceiling_dbfs": -0.5,
        "gain_mode": "acoustic"
    },
    "nu_metal": {
        "q1_mono_cutoff_hz": 140,
        "q1_bass_gain_db": 2.5,
        "q2_stereo_width": 1.35,
        "q2_drive": 5.0,
        "q3_vocal_boost_db": 2.5,
        "q3_air_shelf_db": 2.0,
        "q3_air_cutoff_hz": 8000,
        "q4_threshold_dbfs": -2.5,
        "q4_ceiling_dbfs": -0.3,
        "gain_mode": "acoustic"
    },
    "rap_rock": {
        "q1_mono_cutoff_hz": 130,
        "q1_bass_gain_db": 2.0,
        "q2_stereo_width": 1.15,
        "q2_drive": 3.0,
        "q3_vocal_boost_db": 3.0,
        "q3_air_shelf_db": 2.0,
        "q3_air_cutoff_hz": 8000,
        "q4_threshold_dbfs": -3.0,
        "q4_ceiling_dbfs": -0.5,
        "gain_mode": "acoustic"
    },
    "amapiano": {
        "q1_mono_cutoff_hz": 160,
        "q1_bass_gain_db": 3.0,
        "q2_stereo_width": 1.40,
        "q2_drive": 1.5,
        "q3_vocal_boost_db": 1.0,
        "q3_air_shelf_db": 2.5,
        "q3_air_cutoff_hz": 10000,
        "q4_threshold_dbfs": -4.0,
        "q4_ceiling_dbfs": -0.8,
        "gain_mode": "linear"
    },
    "reggae": {
        "q1_mono_cutoff_hz": 110,
        "q1_bass_gain_db": 3.5,
        "q2_stereo_width": 1.10,
        "q2_drive": 1.2,
        "q3_vocal_boost_db": 1.5,
        "q3_air_shelf_db": 0.5,
        "q3_air_cutoff_hz": 10000,
        "q4_threshold_dbfs": -4.5,
        "q4_ceiling_dbfs": -0.5,
        "gain_mode": "acoustic"
    }
}

Q1_KEYWORDS = ("kick", "bass", "sub", "808", "low", "bd_", "bassline")
Q3_KEYWORDS = ("vocal", "vox", "lead", "adlib", "snare", "cymbal", "hat", "hihat", "ride", "shaker")


# ---------------------------------------------------------------------------
# Frequency-domain helpers
# ---------------------------------------------------------------------------

def split_bands(signal: np.ndarray, sample_rate: int, cutoff_hz: float):
    """
    Split into (below cutoff, at-or-above cutoff) via rfft.

    Returned bands sum back to the input exactly, so recombining after treating
    them differently introduces no gain error.
    """
    n = len(signal)
    if n == 0:
        return signal.copy(), signal.copy()

    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    mask_low = freqs < cutoff_hz

    low = np.zeros_like(signal)
    high = np.zeros_like(signal)

    for ch in range(signal.shape[1]):
        spectrum = np.fft.rfft(signal[:, ch])
        low[:, ch] = np.fft.irfft(spectrum * mask_low, n=n)
        high[:, ch] = np.fft.irfft(spectrum * (~mask_low), n=n)

    return low, high


def apply_high_shelf(signal: np.ndarray, sample_rate: int, cutoff_hz: float, gain_db: float) -> np.ndarray:
    """Boost everything at or above cutoff_hz by gain_db."""
    if abs(gain_db) < 1e-6 or len(signal) == 0:
        return signal

    n = len(signal)
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    gain = np.where(freqs >= cutoff_hz, dbfs_to_linear(gain_db), 1.0)

    out = np.zeros_like(signal)
    for ch in range(signal.shape[1]):
        out[:, ch] = np.fft.irfft(np.fft.rfft(signal[:, ch]) * gain, n=n)

    return out


def spectral_centroid(signal: np.ndarray, sample_rate: int) -> float:
    """Energy-weighted mean frequency, used to route unlabelled stems."""
    mono = signal.mean(axis=1)
    if len(mono) == 0:
        return 0.0

    spectrum = np.abs(np.fft.rfft(mono))
    freqs = np.fft.rfftfreq(len(mono), d=1.0 / sample_rate)
    total = spectrum.sum()

    if total < 1e-12:
        return 0.0
    return float((freqs * spectrum).sum() / total)


def classify_stem(filename: str, signal: np.ndarray, sample_rate: int) -> int:
    """Returns 1, 2 or 3. Filename keywords win; otherwise route on centroid."""
    lower = filename.lower()

    if any(k in lower for k in Q1_KEYWORDS):
        return 1
    if any(k in lower for k in Q3_KEYWORDS):
        return 3

    centroid = spectral_centroid(signal, sample_rate)

    # Thresholds chosen to bracket the mid-body: below ~250 Hz is foundation
    # material, above ~4 kHz is air and transient content.
    if centroid < 250.0:
        return 1
    if centroid > 4000.0:
        return 3
    return 2


# ---------------------------------------------------------------------------
# Quadrants
# ---------------------------------------------------------------------------

def process_quadrant_1_foundation(stems, profile, sample_rate):
    """Mono-collapse below the cutoff only, leaving upper harmonics in stereo."""
    if not stems:
        return None

    summed = sum_aligned(stems)
    cutoff = float(profile["q1_mono_cutoff_hz"])

    low, high = split_bands(summed, sample_rate, cutoff)

    # Collapsing only the low band preserves stereo information above it, which a
    # full-signal mono fold would destroy.
    mid = (low[:, 0] + low[:, 1]) * 0.5
    low_mono = np.column_stack((mid, mid))

    gain = dbfs_to_linear(profile["q1_bass_gain_db"])
    return (low_mono + high) * gain


def process_quadrant_2_harmonics(stems, profile, sample_rate):
    """Harmonic drive, then mid/side width expansion."""
    if not stems:
        return None

    summed = sum_aligned(stems)

    drive = float(profile["q2_drive"])
    driven = np.tanh(summed * (1.0 + drive * 0.1))

    width = float(profile["q2_stereo_width"])
    mid = (driven[:, 0] + driven[:, 1]) * 0.5
    side = (driven[:, 1] - driven[:, 0]) * 0.5 * width

    return np.column_stack((mid - side, mid + side))


def process_quadrant_3_leads(stems, profile, sample_rate):
    """High-shelf air excitation, then presence gain."""
    if not stems:
        return None

    summed = sum_aligned(stems)

    aired = apply_high_shelf(
        summed,
        sample_rate,
        float(profile.get("q3_air_cutoff_hz", 8000)),
        float(profile["q3_air_shelf_db"])
    )

    return aired * dbfs_to_linear(profile["q3_vocal_boost_db"])


def sum_aligned(stems):
    """Zero-pad to the longest stem, then sum."""
    max_len = max(len(s) for s in stems)
    padded = [np.pad(s, ((0, max_len - len(s)), (0, 0)), mode="constant") for s in stems]
    return np.sum(padded, axis=0)


def process_quadrant_4_cylinder_bus(quadrants, profile, sample_rate, output_path,
                                    bit_depth=16, enable_dither=True):
    """
    Sum the populated quadrants, normalise, limit, then quantize.

    Normalisation divides by the count of quadrants that actually carry audio.
    Dividing by a fixed 3 when one is empty would attenuate the master by up to
    4.8 dB for no reason.
    """
    active = [q for q in quadrants if q is not None and len(q) > 0]

    if not active:
        raise ValueError("All quadrants are empty; nothing to render.")

    master_bus = sum_aligned(active)
    n = len(active)

    if profile["gain_mode"] == "acoustic":
        master_bus = master_bus / np.sqrt(float(n))
    elif profile["gain_mode"] == "linear":
        master_bus = master_bus / float(n)

    limited = apply_soft_knee_limiter(
        master_bus,
        threshold_linear=dbfs_to_linear(profile["q4_threshold_dbfs"]),
        ceiling_linear=dbfs_to_linear(profile["q4_ceiling_dbfs"])
    )

    write_wav_float32(output_path, limited, sample_rate,
                      target_bit_depth=bit_depth, enable_dither=enable_dither)

    peak = float(np.max(np.abs(limited)))
    print(f"[QUADRANT DSP COMPLETE] Output -> {output_path}")
    print(f"  Active quadrants : {n}/3 (gain mode: {profile['gain_mode']}, /{'sqrt(%d)' % n if profile['gain_mode'] == 'acoustic' else n})")
    print(f"  Master peak      : {linear_to_dbfs(peak):.2f} dBFS (ceiling {profile['q4_ceiling_dbfs']} dBFS)")
    print(f"  Export           : {bit_depth}-bit {'TPDF dithered' if enable_dither else 'no dither'}")


def resolve_profile(genre: str):
    """Returns (profile, description). Falls back through the genre families."""
    profile = GENRE_PROFILES.get(genre.lower())
    if profile is not None:
        return profile, genre.lower()

    try:
        from genre_resolver import family_of, slugify
        family = family_of(slugify(genre))
        family_defaults = {
            "metal": "nu_metal",
            "rock": "heavy_alternative_rock",
            "hiphop": "rap_rock",
            "electronic": "amapiano",
            "world": "reggae",
            "pop": "heavy_alternative_rock",
        }
        mapped = family_defaults.get(family)
        if mapped:
            return GENRE_PROFILES[mapped], f"{genre} -> {family} family -> {mapped}"
    except Exception:
        pass

    return GENRE_PROFILES["heavy_alternative_rock"], f"{genre} -> default (heavy_alternative_rock)"


def process_position_quadrants(stem_arrays, filenames, profile, sample_rate):
    """
    Run the quadrant matrix over the stems at ONE timeline position.

    Used by cylinder_premix_overlay.py so quadrant routing happens vertically,
    per position, leaving the concatenated track length untouched. Returns a
    single composite array rather than writing a file.
    """
    q1, q2, q3 = [], [], []

    for data, name in zip(stem_arrays, filenames):
        cleaned = apply_dc_blocker(data)
        q = classify_stem(name, cleaned, sample_rate)
        if q == 1:
            q1.append(cleaned)
        elif q == 3:
            q3.append(cleaned)
        else:
            q2.append(cleaned)

    q1_out = process_quadrant_1_foundation(q1, profile, sample_rate)
    q2_out = process_quadrant_2_harmonics(q2, profile, sample_rate)
    q3_out = process_quadrant_3_leads(q3, profile, sample_rate)

    active = [q for q in (q1_out, q2_out, q3_out) if q is not None and len(q) > 0]
    if not active:
        return None, (0, 0, 0)

    master_bus = sum_aligned(active)
    n = len(active)

    if profile["gain_mode"] == "acoustic":
        master_bus = master_bus / np.sqrt(float(n))
    elif profile["gain_mode"] == "linear":
        master_bus = master_bus / float(n)

    limited = apply_soft_knee_limiter(
        master_bus,
        threshold_linear=dbfs_to_linear(profile["q4_threshold_dbfs"]),
        ceiling_linear=dbfs_to_linear(profile["q4_ceiling_dbfs"])
    )

    return limited, (len(q1), len(q2), len(q3))


def execute_genre_quadrants(stems_dir, genre, output_path, bit_depth=16, enable_dither=True):
    profile = GENRE_PROFILES.get(genre.lower())
    profile_source = genre.lower()

    if profile is None:
        # Fall back through the genre resolver's family map so any of the 221
        # corpus genres gets a sensible quadrant profile.
        try:
            from genre_resolver import family_of, slugify
            family = family_of(slugify(genre))
            family_defaults = {
                "metal": "nu_metal",
                "rock": "heavy_alternative_rock",
                "hiphop": "rap_rock",
                "electronic": "amapiano",
                "world": "reggae",
                "pop": "heavy_alternative_rock",
            }
            mapped = family_defaults.get(family)
            if mapped:
                profile = GENRE_PROFILES[mapped]
                profile_source = f"{genre} -> {family} family -> {mapped}"
        except Exception:
            pass

    if profile is None:
        profile = GENRE_PROFILES["heavy_alternative_rock"]
        profile_source = f"{genre} -> default (heavy_alternative_rock)"

    files = [f for f in os.listdir(stems_dir) if f.lower().endswith(".wav")]
    if not files:
        raise FileNotFoundError(f"No WAV files in {stems_dir}")

    q1_stems, q2_stems, q3_stems = [], [], []
    sample_rate = 44100
    routed_by_keyword = 0

    for f in sorted(files):
        data, sr = read_wav_float32(os.path.join(stems_dir, f))
        sample_rate = sr
        data = apply_dc_blocker(data)

        lower = f.lower()
        if any(k in lower for k in Q1_KEYWORDS) or any(k in lower for k in Q3_KEYWORDS):
            routed_by_keyword += 1

        q = classify_stem(f, data, sr)
        if q == 1:
            q1_stems.append(data)
        elif q == 3:
            q3_stems.append(data)
        else:
            q2_stems.append(data)

    print(f"Running Quadrant Matrix for genre: {genre.upper()}")
    print(f"  Profile source          : {profile_source}")
    print(f"  Q1 Stems (Foundation)   : {len(q1_stems)}")
    print(f"  Q2 Stems (Harmonics)    : {len(q2_stems)}")
    print(f"  Q3 Stems (Leads/Vox)    : {len(q3_stems)}")
    print(f"  Routed by filename      : {routed_by_keyword}/{len(files)}")

    if routed_by_keyword == 0:
        print("  [NOTE] No filename role hints found; routing was spectral. Quadrant")
        print("         separation is approximate on full-mix material.")

    q1_out = process_quadrant_1_foundation(q1_stems, profile, sample_rate)
    q2_out = process_quadrant_2_harmonics(q2_stems, profile, sample_rate)
    q3_out = process_quadrant_3_leads(q3_stems, profile, sample_rate)

    process_quadrant_4_cylinder_bus(
        [q1_out, q2_out, q3_out], profile, sample_rate, output_path,
        bit_depth=bit_depth, enable_dither=enable_dither
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Genre-Specific 4-Quadrant DSP Engine")
    parser.add_argument("--stems-dir", required=True)
    parser.add_argument("--genre", default="heavy_alternative_rock")
    parser.add_argument("--output", required=True)
    parser.add_argument("--bit-depth", type=int, choices=[16, 24], default=16)
    parser.add_argument("--no-dither", action="store_true")
    parser.add_argument("--list-profiles", action="store_true", help="Print available genre profiles and exit")
    args = parser.parse_args()

    if args.list_profiles:
        for name, p in GENRE_PROFILES.items():
            print(f"{name:<26} Q1 mono<{p['q1_mono_cutoff_hz']}Hz +{p['q1_bass_gain_db']}dB | "
                  f"Q2 width {p['q2_stereo_width']:.2f} drive {p['q2_drive']} | "
                  f"Q3 air +{p['q3_air_shelf_db']}dB@{p['q3_air_cutoff_hz']}Hz vox +{p['q3_vocal_boost_db']}dB | "
                  f"Q4 {p['q4_threshold_dbfs']}/{p['q4_ceiling_dbfs']} dBFS {p['gain_mode']}")
        sys.exit(0)

    execute_genre_quadrants(args.stems_dir, args.genre, args.output,
                            args.bit_depth, not args.no_dither)
