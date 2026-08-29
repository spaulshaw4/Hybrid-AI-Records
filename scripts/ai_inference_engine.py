# D:\MusicDatasets\scripts\ai_inference_engine.py
import os
import argparse
from pydub import AudioSegment, effects

# Per-genre overrides. Anything not listed here resolves through
# FAMILY_PROFILES, so all 221 genres in the corpus get a sensible curve rather
# than silently inheriting a rock profile.
GENRE_PROFILES = {
    "heavy_alternative_rock": {
        "bass_boost_db": 3.0,
        "high_shelf_db": 2.0,
        "target_dbfs": -12.0,
        "fade_ms": 10
    },
    "nu_metal": {
        "bass_boost_db": 4.5,
        "high_shelf_db": 1.5,
        "target_dbfs": -11.0,
        "fade_ms": 8
    },
    "rap_rock": {
        "bass_boost_db": 3.5,
        "high_shelf_db": 2.5,
        "target_dbfs": -12.0,
        "fade_ms": 10
    },
    "amapiano": {
        "bass_boost_db": 5.0,
        "high_shelf_db": 3.0,
        "target_dbfs": -13.0,
        "fade_ms": 12
    }
}

# Family-level curves, keyed to the same families genre_resolver.py uses.
FAMILY_PROFILES = {
    "rock":         {"bass_boost_db": 3.0, "high_shelf_db": 2.0, "target_dbfs": -12.0, "fade_ms": 10},
    "metal":        {"bass_boost_db": 4.5, "high_shelf_db": 1.5, "target_dbfs": -11.0, "fade_ms": 8},
    "hiphop":       {"bass_boost_db": 4.0, "high_shelf_db": 2.5, "target_dbfs": -12.0, "fade_ms": 10},
    "electronic":   {"bass_boost_db": 5.0, "high_shelf_db": 3.0, "target_dbfs": -13.0, "fade_ms": 12},
    "ambient":      {"bass_boost_db": 1.0, "high_shelf_db": 1.0, "target_dbfs": -16.0, "fade_ms": 25},
    "jazz":         {"bass_boost_db": 1.5, "high_shelf_db": 1.5, "target_dbfs": -14.0, "fade_ms": 15},
    "acoustic":     {"bass_boost_db": 1.0, "high_shelf_db": 2.0, "target_dbfs": -14.0, "fade_ms": 15},
    "classical":    {"bass_boost_db": 0.0, "high_shelf_db": 1.0, "target_dbfs": -16.0, "fade_ms": 25},
    "world":        {"bass_boost_db": 2.5, "high_shelf_db": 2.0, "target_dbfs": -13.0, "fade_ms": 12},
    "pop":          {"bass_boost_db": 3.0, "high_shelf_db": 2.5, "target_dbfs": -12.0, "fade_ms": 10},
    "experimental": {"bass_boost_db": 1.0, "high_shelf_db": 1.0, "target_dbfs": -15.0, "fade_ms": 20},
}

# Neutral curve for genres with no override and no recognised family: gentle
# normalisation and anti-click fades only, no tonal opinion.
NEUTRAL_PROFILE = {"bass_boost_db": 0.0, "high_shelf_db": 0.0, "target_dbfs": -14.0, "fade_ms": 12}


def select_profile(genre_lock: str) -> tuple:
    """Returns (profile, description) for any genre in the 221-label vocabulary."""
    if genre_lock in GENRE_PROFILES:
        return GENRE_PROFILES[genre_lock], f"explicit override '{genre_lock}'"

    family = None
    try:
        from genre_resolver import family_of, slugify
        family = family_of(slugify(genre_lock))
    except Exception:
        pass

    if family and family in FAMILY_PROFILES:
        return FAMILY_PROFILES[family], f"'{family}' family curve"

    return NEUTRAL_PROFILE, "neutral curve (no override or family match)"


def apply_genre_eq(audio_segment: AudioSegment, profile: dict) -> AudioSegment:
    # Micro-fades at slice boundaries to prevent transient clicks
    fade_len = profile.get("fade_ms", 10)
    conditioned = audio_segment.fade_in(fade_len).fade_out(fade_len)

    # Apply genre-specific tone shaping
    bass_boost = profile.get("bass_boost_db", 0.0)
    high_boost = profile.get("high_shelf_db", 0.0)

    if bass_boost > 0:
        low_band = conditioned.low_pass_filter(250) + bass_boost
        mid_high_band = conditioned.high_pass_filter(250)
        conditioned = low_band.overlay(mid_high_band)

    if high_boost > 0:
        high_band = conditioned.high_pass_filter(4000) + high_boost
        low_mid_band = conditioned.low_pass_filter(4000)
        conditioned = low_mid_band.overlay(high_band)

    # Normalize audio levels
    target_dbfs = profile.get("target_dbfs", -12.0)
    normalized = effects.normalize(conditioned)
    gain_adjustment = target_dbfs - normalized.dBFS

    return normalized.apply_gain(gain_adjustment)


def run_inference(session_id: str, work_dir: str, genre_lock: str):
    print("\n================================================================")
    print(f"AI INFERENCE & STEM CONDITIONING ENGINE: {session_id}")
    print(f"Genre Target: {genre_lock}")
    print("================================================================")

    raw_stems_dir = os.path.join(work_dir, "raw_stems")

    if not os.path.exists(raw_stems_dir):
        raise FileNotFoundError(f"Raw stems directory not found: {raw_stems_dir}")

    stem_files = sorted([f for f in os.listdir(raw_stems_dir) if f.endswith(".wav")])

    if not stem_files:
        raise ValueError(f"No stem slices available in {raw_stems_dir} for conditioning.")

    profile, profile_desc = select_profile(genre_lock)

    print(f"[INFERENCE] Processing {len(stem_files)} sequential stems using {profile_desc}")

    for idx, filename in enumerate(stem_files):
        stem_path = os.path.join(raw_stems_dir, filename)
        segment = AudioSegment.from_file(stem_path)
        conditioned_segment = apply_genre_eq(segment, profile)
        conditioned_segment.export(stem_path, format="wav")

        if (idx + 1) % 50 == 0 or (idx + 1) == len(stem_files):
            print(f"  -> Conditioned {idx + 1}/{len(stem_files)} stems...")

    print(f"[SUCCESS] AI inference conditioning complete for session {session_id}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 AI Inference & Stem Conditioning Engine")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory path")
    parser.add_argument("--genre", default="heavy_alternative_rock", help="Genre lock")
    args = parser.parse_args()

    run_inference(args.session, args.dir, args.genre)
