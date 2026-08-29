# D:\MusicDatasets\scripts\genre_resolver.py
"""
Resolves a requested genre to one that actually has slices behind it.

Why this exists
---------------
run_master_pipeline.ps1 stages from uploaded_slices\\<GenreLock>\\ and aborts with
"No audio slices found" when that folder is empty. Three of the four genres
originally wired into the UI - heavy_alternative_rock, nu_metal, rap_rock - are
composite names that match no label in either source dataset, so they would
always have hit that abort. amapiano has no source at all: both FMA and
MTG-Jamendo predate it.

Rather than fail, resolve the request down a chain:

  1. exact match on an available genre
  2. explicit alias (curated, in ALIAS_MAP)
  3. acoustic family sibling with the most material
  4. broad family root
  5. the largest available genre overall

Every resolution reports which rule fired, so a caller can log that a render
used a substitute rather than the literal request.
"""

import os
import sys
import json
import argparse
from pathlib import Path

BASE_DIR = Path(r"D:\MusicDatasets")
SLICES_DIR = BASE_DIR / "uploaded_slices"


def slugify(name: str) -> str:
    keep = []
    for ch in str(name).lower():
        if ch.isalnum():
            keep.append(ch)
        elif ch in " -/_&:":
            keep.append("_")
    slug = "".join(keep)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_")


# ---------------------------------------------------------------------------
# Curated aliases: requested genre -> ordered fallback candidates.
# Ordering matters; the first candidate with real slices wins.
# ---------------------------------------------------------------------------
ALIAS_MAP = {
    # The four genres the UI originally shipped with
    "heavy_alternative_rock": ["loud_rock", "hardrock", "alternativerock", "alternative", "indie_rock", "rock"],
    "nu_metal":               ["metal", "heavymetal", "industrial", "hardcore", "loud_rock", "rock"],
    "rap_rock":               ["alternative_hip_hop", "hip_hop", "loud_rock", "rap", "rock"],
    "amapiano":               ["deephouse", "house", "african", "afrobeat", "electronic"],

    # Contemporary genres postdating both datasets
    "afrobeats":     ["afrobeat", "african", "world", "reggae"],
    "drill":         ["hip_hop", "rap", "alternative_hip_hop", "abstract_hip_hop"],
    "trap":          ["hip_hop", "hip_hop_beats", "rap", "abstract_hip_hop"],
    "phonk":         ["trip_hop", "hip_hop_beats", "lo_fi", "hip_hop"],
    "hyperpop":      ["experimental_pop", "electropop", "synth_pop", "glitch", "pop"],
    "vaporwave":     ["chill_out", "lo_fi", "ambient_electronic", "downtempo"],
    "synthwave":     ["synth_pop", "electronic", "minimal_electronic", "electronica"],
    "reggaeton":     ["latin", "reggae_dancehall", "dub", "latin_america"],
    "dembow":        ["reggae_dancehall", "latin", "reggae"],
    "grime":         ["dubstep", "hip_hop", "jungle", "breakbeat"],
    "future_bass":   ["dubstep", "electronic", "edm", "breakbeat"],
    "lofi_hip_hop":  ["lo_fi", "hip_hop_beats", "trip_hop", "downtempo"],
    "kpop":          ["synth_pop", "electropop", "pop", "dance"],
    "jpop":          ["synth_pop", "pop", "electropop"],
    "afro_house":    ["deephouse", "house", "african", "tribal"],
    "gqom":          ["deephouse", "house", "african", "tribal"],
    "kwaito":        ["african", "house", "hip_hop"],

    # Heavier subgenres absent from the vocabulary
    "metalcore":     ["metal", "hardcore", "thrash", "grindcore", "loud_rock"],
    "deathcore":     ["death_metal", "metal", "grindcore", "hardcore"],
    "post_hardcore": ["hardcore", "post_punk", "loud_rock", "punk"],
    "djent":         ["progressive", "metal", "heavymetal", "instrumentalrock"],
    "emo":           ["post_punk", "punk", "indie_rock", "alternative"],
    "math_rock":     ["post_rock", "progressive", "instrumentalrock", "noise_rock"],

    # Jazz and roots subgenres
    "bebop":         ["modern_jazz", "jazz", "free_jazz", "big_band_swing"],
    "hard_bop":      ["modern_jazz", "jazz", "free_jazz"],
    "smooth_jazz":   ["nu_jazz", "acidjazz", "jazz", "lounge"],
    "gypsy_jazz":    ["romany_gypsy", "jazz", "swing"],
    "delta_blues":   ["blues", "bluesrock", "americana"],
    "chicago_blues": ["blues", "bluesrock", "rocknroll"],
    "zydeco":        ["cajun", "americana", "folk", "country"],
    "cajun":         ["americana", "folk", "country", "bluegrass"],

    # Latin / world
    "bachata":       ["latin", "salsa", "latin_america"],
    "merengue":      ["latin", "salsa", "cumbia", "latin_america"],
    "sertanejo":     ["brazilian", "latin_america", "country"],
    "forro":         ["brazilian", "latin_america", "cumbia"],
    "bhangra":       ["indian", "n_indian_traditional", "world", "ethno"],
    "soca":          ["reggae_dancehall", "latin", "african", "tribal"],
    "highlife":      ["afrobeat", "african", "world"],
}


# ---------------------------------------------------------------------------
# Acoustic families. Used when no explicit alias matches: pick the family
# sibling with the most slices, then the family root.
# ---------------------------------------------------------------------------
ACOUSTIC_FAMILIES = {
    "rock": [
        "rock", "loud_rock", "hardrock", "alternativerock", "alternative", "indie_rock",
        "punk", "punkrock", "post_punk", "post_rock", "noise_rock", "psych_rock",
        "grunge", "shoegaze", "garage", "space_rock", "krautrock", "classicrock",
        "rocknroll", "instrumentalrock", "progressive", "power_pop", "new_wave",
        "no_wave", "surf", "rockabilly", "bluesrock", "ethnicrock", "rock_opera",
    ],
    "metal": [
        "metal", "heavymetal", "death_metal", "black_metal", "thrash", "grindcore",
        "sludge", "hardcore", "industrial", "goth", "gothic", "darkwave",
    ],
    "hiphop": [
        "hip_hop", "rap", "alternative_hip_hop", "abstract_hip_hop", "hip_hop_beats",
        "trip_hop", "nerdcore", "turntablism",
    ],
    "electronic": [
        "electronic", "electronica", "techno", "house", "deephouse", "trance", "edm",
        "idm", "dubstep", "drum_bass", "drumnbass", "jungle", "breakbeat", "breakcore_hard",
        "glitch", "minimal", "minimal_electronic", "downtempo", "club", "dance",
        "eurodance", "bigbeat", "chip_music", "chiptune", "skweee", "wonky", "electro_punk",
    ],
    "ambient": [
        "ambient", "ambient_electronic", "darkambient", "drone", "atmospheric", "new_age",
        "chill_out", "lounge", "minimalism", "electroacoustic", "field_recordings",
    ],
    "jazz": [
        "jazz", "free_jazz", "modern_jazz", "nu_jazz", "acidjazz", "jazzfusion", "jazzfunk",
        "fusion", "swing", "big_band_swing", "jazz_vocal", "jazz_out", "bossanova",
    ],
    "acoustic": [
        "folk", "popfolk", "psych_folk", "freak_folk", "free_folk", "british_folk",
        "singer_songwriter", "americana", "bluegrass", "country", "country_western",
        "celtic", "blues", "gospel", "medieval", "choir", "choral_music",
    ],
    "classical": [
        "classical", "contemporary_classical", "20th_century_classical", "orchestral",
        "symphonic", "symphony", "chamber_music", "opera", "composed_music", "soundtrack",
    ],
    "world": [
        "world", "worldfusion", "international", "african", "afrobeat", "north_african",
        "latin", "latin_america", "brazilian", "cumbia", "salsa", "tango", "flamenco",
        "fado", "reggae", "reggae_dub", "reggae_dancehall", "dub", "ska", "indian",
        "middle_east", "oriental", "turkish", "klezmer", "balkan", "romany_gypsy",
        "asia_far_east", "pacific", "ethno", "tribal", "polka",
    ],
    "pop": [
        "pop", "synth_pop", "electropop", "experimental_pop", "instrumentalpop", "poprock",
        "disco", "soul", "soul_rnb", "rnb", "funk", "deep_funk", "groove", "easy_listening",
    ],
    "experimental": [
        "experimental", "avant_garde", "noise", "musique_concrete", "sound_collage",
        "sound_art", "audio_collage", "improv", "improvisation", "unclassifiable",
        "sound_poetry", "radio_art",
    ],
}

# Reverse index: genre slug -> family
_GENRE_TO_FAMILY = {}
for _family, _members in ACOUSTIC_FAMILIES.items():
    for _m in _members:
        _GENRE_TO_FAMILY.setdefault(_m, _family)


def discover_available(slices_dir: Path = SLICES_DIR, min_slices: int = 1) -> dict:
    """Returns {genre_slug: slice_count} for genres with real slices on disk."""
    available = {}

    if not slices_dir.exists():
        return available

    for entry in slices_dir.iterdir():
        if not entry.is_dir():
            continue
        try:
            count = sum(1 for f in entry.iterdir() if f.suffix.lower() == ".wav")
        except OSError:
            continue
        if count >= min_slices:
            available[slugify(entry.name)] = count

    return available


def family_of(genre_slug: str) -> str | None:
    return _GENRE_TO_FAMILY.get(genre_slug)


def resolve_genre(requested: str, available: dict, min_slices: int = 150) -> dict:
    """
    Resolve `requested` against `available` ({slug: count}).

    Returns a dict with resolved slug, the rule that fired, and whether the
    result is the literal request or a substitute.
    """
    req = slugify(requested)
    viable = {g: c for g, c in available.items() if c >= min_slices}

    def result(slug, rule, note):
        return {
            "requested": req,
            "resolved": slug,
            "rule": rule,
            "note": note,
            "exact": slug == req,
            "slice_count": available.get(slug, 0),
            "viable_genres": len(viable),
        }

    if not available:
        return result(None, "none_available", "No genre folders contain slices yet.")

    # 1. Exact match with enough material
    if req in viable:
        return result(req, "exact", f"{viable[req]} slices available.")

    # Exact match but too thin to complete a render
    if req in available:
        thin_note = f"only {available[req]} slices, under the {min_slices} needed for one render"
    else:
        thin_note = "no slices staged"

    # 2. Curated alias chain
    for candidate in ALIAS_MAP.get(req, []):
        cand = slugify(candidate)
        if cand in viable:
            return result(cand, "alias", f"'{req}' has {thin_note}; aliased to nearest profile.")

    # 3. Acoustic family sibling with the most material
    fam = family_of(req)
    if not fam:
        # Infer family from a substring hit against known members
        for member, member_fam in _GENRE_TO_FAMILY.items():
            if member in req or req in member:
                fam = member_fam
                break

    if fam:
        siblings = [(g, c) for g, c in viable.items() if family_of(g) == fam]
        if siblings:
            best = max(siblings, key=lambda x: x[1])
            return result(best[0], "family_sibling", f"'{req}' has {thin_note}; using '{fam}' family sibling.")

    # 4. Largest available genre overall
    if viable:
        best = max(viable.items(), key=lambda x: x[1])
        return result(best[0], "largest_available", f"'{req}' has {thin_note}; no family match, using largest pool.")

    # 5. Nothing meets the render minimum
    best = max(available.items(), key=lambda x: x[1])
    return result(best[0], "below_minimum",
                  f"No genre reaches {min_slices} slices; largest is '{best[0]}' at {best[1]}.")


def main():
    parser = argparse.ArgumentParser(description="Resolve a genre to one with real slices behind it")
    parser.add_argument("--requested", required=True, help="Genre the caller asked for")
    parser.add_argument("--slices-dir", default=str(SLICES_DIR), help="uploaded_slices root")
    parser.add_argument("--min-slices", type=int, default=150,
                        help="Slices needed for the 2:30 minimum render (default 150)")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of the bare slug")
    parser.add_argument("--list-available", action="store_true", help="List every genre with slice counts")
    args = parser.parse_args()

    available = discover_available(Path(args.slices_dir))

    if args.list_available:
        if not available:
            print("No genres staged yet.")
            return
        for g, c in sorted(available.items(), key=lambda x: -x[1]):
            marker = "OK " if c >= args.min_slices else "THIN"
            print(f"  [{marker}] {g:<32} {c:>8} slices")
        print(f"\n{len(available)} genres present, "
              f"{sum(1 for c in available.values() if c >= args.min_slices)} render-ready.")
        return

    outcome = resolve_genre(args.requested, available, args.min_slices)

    if args.json:
        print(json.dumps(outcome, indent=2))
    else:
        # Bare slug on stdout so PowerShell can consume it directly
        print(outcome["resolved"] or "")

    if not outcome["resolved"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
