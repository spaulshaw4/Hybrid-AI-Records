# D:\MusicDatasets\scripts\build_genre_corpus.py
"""
Builds a genre-labelled staging corpus from the extracted datasets.

The pipeline keys everything off genre: watchdog_slicing_daemon and local_slicer
derive genre from the parent folder name, run_master_pipeline stages from
uploaded_slices\\<GenreLock>\\, and ai_inference_engine filters on it. So the job
here is to sort source audio into incoming\\<genre>\\ folders using each dataset's
own metadata rather than its directory layout, which is organised by dataset.

Sources
-------
FMA          fma_metadata/tracks.csv       track_id -> genres_all (fine-grained)
             fma_metadata/genres.csv       genre_id -> title (163-genre hierarchy)
             audio at fma_large/NNN/NNNNNN.mp3
MTG-Jamendo  data/autotagging_genre.tsv    PATH -> genre---<tag> (95 tags)
             audio at raw_30s_audio*/NN/TRACKID.mp3

Together these cover 221 distinct genres. Files are hard-linked rather than
copied where possible: the staging tree and the datasets share one volume, so
links cost no space, and local_slicer moving a link to archive/ leaves the
original dataset file untouched.
"""

import os
import csv
import sys
import ast
import argparse
import collections
from pathlib import Path

BASE_DIR = Path(r"D:\MusicDatasets")
INCOMING_DIR = BASE_DIR / "incoming"

FMA_META = BASE_DIR / "fma" / "fma_metadata" / "fma_metadata"
MTG_GENRE_TSV = BASE_DIR / "mtg" / "data" / "autotagging_genre.tsv"

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}

# A 2:30 render consumes 150 one-second slices. A genre below this cannot produce a
# single complete track, so offering it in the UI would be a dead end.
SLICES_PER_RENDER = 150


def slugify_genre(name: str) -> str:
    keep = []
    for ch in name.lower():
        if ch.isalnum():
            keep.append(ch)
        elif ch in " -/_&:":
            keep.append("_")
    slug = "".join(keep)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_") or "unknown"


# ---------------------------------------------------------------------------
# FMA
# ---------------------------------------------------------------------------

def load_fma_genre_names() -> dict:
    path = FMA_META / "genres.csv"
    if not path.exists():
        return {}

    names = {}
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                names[int(row["genre_id"])] = row["title"].strip()
            except (ValueError, KeyError):
                continue
    return names


def load_fma_track_genres(genre_names: dict, fine_grained: bool = True) -> dict:
    """Returns {track_id: [genre titles]} from the multi-index tracks.csv."""
    path = FMA_META / "tracks.csv"
    if not path.exists():
        return {}

    result = {}

    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        level0 = next(reader)
        level1 = next(reader)
        next(reader)  # the 'track_id' marker row

        def find_col(group, name):
            for i in range(len(level0)):
                if level0[i] == group and level1[i] == name:
                    return i
            return None

        col_genres_all = find_col("track", "genres_all")
        col_genre_top = find_col("track", "genre_top")

        for row in reader:
            if not row or not row[0].strip():
                continue
            try:
                track_id = int(row[0])
            except ValueError:
                continue

            titles = []

            if fine_grained and col_genres_all is not None:
                raw = row[col_genres_all].strip()
                if raw and raw != "[]":
                    try:
                        for gid in ast.literal_eval(raw):
                            t = genre_names.get(int(gid))
                            if t:
                                titles.append(t)
                    except (ValueError, SyntaxError):
                        pass

            if not titles and col_genre_top is not None:
                top = row[col_genre_top].strip()
                if top:
                    titles.append(top)

            if titles:
                result[track_id] = titles

    return result


def index_fma_audio() -> dict:
    """Returns {track_id: Path}. FMA lays audio out as NNN/NNNNNN.mp3."""
    index = {}
    for root in BASE_DIR.glob("fma*/**/fma_large"):
        for sub in root.iterdir():
            if not sub.is_dir():
                continue
            for f in sub.iterdir():
                if f.suffix.lower() in AUDIO_EXTS:
                    try:
                        index[int(f.stem)] = f
                    except ValueError:
                        continue
    # fma_full / other variants
    if not index:
        for pattern in ("fma*/**/*.mp3",):
            for f in BASE_DIR.glob(pattern):
                if f.parent.name.isdigit() and len(f.parent.name) == 3:
                    try:
                        index[int(f.stem)] = f
                    except ValueError:
                        continue
    return index


# ---------------------------------------------------------------------------
# MTG-Jamendo
# ---------------------------------------------------------------------------

def load_mtg_track_genres() -> dict:
    """Returns {relative_path: [tags]} e.g. '14/214.mp3' -> ['punkrock']."""
    if not MTG_GENRE_TSV.exists():
        return {}

    result = {}
    with open(MTG_GENRE_TSV, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        try:
            path_idx = header.index("PATH")
        except ValueError:
            path_idx = 3

        for line in f:
            cells = line.rstrip("\n").split("\t")
            if len(cells) <= path_idx:
                continue
            rel = cells[path_idx].strip()
            tags = [c[8:] for c in cells if c.startswith("genre---")]
            if rel and tags:
                result[rel] = tags
    return result


def index_mtg_audio() -> dict:
    """Returns {'NN/TRACKID.mp3': Path} across every extracted raw_30s_audio-*."""
    index = {}
    mtg_root = BASE_DIR / "mtg"
    if not mtg_root.exists():
        return index

    for f in mtg_root.rglob("*.mp3"):
        parent = f.parent.name
        if parent.isdigit():
            index[f"{parent}/{f.name}"] = f
    return index


# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------

def stage_file(src: Path, dest: Path) -> str:
    """Hard-link when possible, else copy. Returns 'link', 'copy', or 'skip'."""
    if dest.exists():
        return "skip"

    dest.parent.mkdir(parents=True, exist_ok=True)

    try:
        os.link(src, dest)
        return "link"
    except OSError:
        import shutil
        shutil.copy2(src, dest)
        return "copy"


def estimate_slices(paths, assumed_seconds_per_file):
    return int(len(paths) * assumed_seconds_per_file)


def main():
    parser = argparse.ArgumentParser(description="Build a genre-labelled staging corpus")
    parser.add_argument("--target-slices", type=int, default=12500,
                        help="Approximate 1s slices to aim for per genre (default 12500)")
    parser.add_argument("--min-slices", type=int, default=SLICES_PER_RENDER,
                        help=f"Skip genres that cannot reach this many slices (default {SLICES_PER_RENDER})")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report coverage without staging any files")
    parser.add_argument("--genre", default=None,
                        help="Only process genres whose slug contains this substring")
    parser.add_argument("--top-level-only", action="store_true",
                        help="Use FMA's 16 top-level genres instead of the 163-genre hierarchy")
    args = parser.parse_args()

    print("=" * 64)
    print("HYBRID 1.0 - GENRE CORPUS BUILDER")
    print("=" * 64)
    print(f"Target slices/genre : {args.target_slices}")
    print(f"Minimum viable      : {args.min_slices} (one full render)")
    print(f"Mode                : {'DRY RUN' if args.dry_run else 'STAGING'}")
    print("=" * 64)

    # genre slug -> list of (source Path, assumed duration seconds)
    buckets = collections.defaultdict(list)

    # --- FMA ---
    print("\n[1/3] Indexing FMA...")
    fma_names = load_fma_genre_names()
    print(f"  genre hierarchy      : {len(fma_names)} genres")

    fma_labels = load_fma_track_genres(fma_names, fine_grained=not args.top_level_only)
    print(f"  labelled tracks      : {len(fma_labels)}")

    fma_audio = index_fma_audio()
    print(f"  audio files on disk  : {len(fma_audio)}")

    matched_fma = 0
    for track_id, titles in fma_labels.items():
        path = fma_audio.get(track_id)
        if not path:
            continue
        matched_fma += 1
        for title in titles:
            buckets[slugify_genre(title)].append((path, 30.0))
    print(f"  matched to audio     : {matched_fma}")

    # --- MTG ---
    print("\n[2/3] Indexing MTG-Jamendo...")
    mtg_labels = load_mtg_track_genres()
    print(f"  labelled tracks      : {len(mtg_labels)}")

    mtg_audio = index_mtg_audio()
    print(f"  audio files on disk  : {len(mtg_audio)}")

    matched_mtg = 0
    for rel, tags in mtg_labels.items():
        path = mtg_audio.get(rel)
        if not path:
            continue
        matched_mtg += 1
        for tag in tags:
            buckets[slugify_genre(tag)].append((path, 30.0))
    print(f"  matched to audio     : {matched_mtg}")

    if not buckets:
        print("\n[HALT] No audio matched any metadata. Extraction is probably still running.")
        print("       FMA expects fma_large/NNN/*.mp3 and MTG expects raw_30s_audio*/NN/*.mp3.")
        sys.exit(1)

    # --- Stage ---
    print(f"\n[3/3] Staging into {INCOMING_DIR}...")

    viable = []
    thin = []

    for slug, entries in sorted(buckets.items()):
        if args.genre and args.genre.lower() not in slug:
            continue

        available = estimate_slices([e[0] for e in entries], entries[0][1])
        if available < args.min_slices:
            thin.append((slug, len(entries), available))
            continue
        viable.append((slug, entries, available))

    staged_total = 0
    linked = copied = skipped = 0

    for slug, entries, available in viable:
        needed_files = max(1, int(args.target_slices / entries[0][1]) + 1)
        chosen = entries[:needed_files]
        dest_dir = INCOMING_DIR / slug

        if args.dry_run:
            print(f"  [PLAN] {slug:<28} {len(chosen):>5} files (~{int(len(chosen)*entries[0][1])} slices, {available} available)")
            staged_total += len(chosen)
            continue

        for src, _dur in chosen:
            dest = dest_dir / f"{slug}__{src.parent.name}_{src.name}"
            result = stage_file(src, dest)
            if result == "link":
                linked += 1
            elif result == "copy":
                copied += 1
            else:
                skipped += 1

        staged_total += len(chosen)
        print(f"  [STAGED] {slug:<28} {len(chosen):>5} files -> incoming/{slug}/")

    print("\n" + "=" * 64)
    print("GENRE COVERAGE SUMMARY")
    print("=" * 64)
    print(f"  Genres viable        : {len(viable)}")
    print(f"  Genres below minimum : {len(thin)}")
    print(f"  Source files staged  : {staged_total}")
    if not args.dry_run:
        print(f"  Hard-linked          : {linked}")
        print(f"  Copied               : {copied}")
        print(f"  Already present      : {skipped}")

    if thin:
        print(f"\n  Genres with under {args.min_slices} slices of audio (cannot complete one render):")
        for slug, files, avail in sorted(thin, key=lambda x: -x[2])[:25]:
            print(f"    {slug:<28} {files:>4} files, ~{avail} slices")

    print("=" * 64)
    print("\nNext: run local_slicer.py to cut incoming/<genre>/ into uploaded_slices/<genre>/,")
    print("      then batch_slicer_upload.py to push slices and ledger rows to Supabase.")


if __name__ == "__main__":
    main()
