"""Build a labeled manifest of 4 s slices with a leakage-safe grouping key.

Two naming conventions live under ``D:\\MusicDatasets\\corpus_4s``:

* musdb tree  -- ``<track dir>/<label>_s4_<n>.wav``
  e.g. ``001 - ANiMAL - Clinic A/bass_s4_00000.wav``
* dsd100 tree -- ``dsd100/<track>__<label>_s<n>.wav`` (flat)
  e.g. ``dsd100/001_animal_clinic_a__bass_s00002.wav``

MUSDB18 absorbed the DSD100 recordings, so the *same* song appears in both trees
under cosmetically different names. Grouping on the raw directory or filename
would put slices of one song on both sides of a split and inflate accuracy. The
grouping key here is a normalized track id (lowercased, alphanumeric-only) which
collapses ``001 - ANiMAL - Clinic A`` and ``001_animal_clinic_a`` onto one group.
"""
from __future__ import annotations

import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

CORPUS_ROOT = r"D:\MusicDatasets\corpus_4s"

#: Stem roles we train on. ``mixture`` is deliberately excluded: it is the full
#: mix, not a stem role the arrangement engine ever needs to select.
CLASSES: tuple[str, ...] = ("drums", "bass", "vocals", "other")

_MUSDB_RE = re.compile(r"^(drums|bass|vocals|other|mixture)_s4_(\d+)\.wav$", re.IGNORECASE)
_DSD_RE = re.compile(
    r"^(?P<track>.+?)__(?P<label>drums|bass|vocals|other|mixture)_s(?P<idx>\d+)\.wav$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class SliceRecord:
    """One labeled slice."""

    path: str
    label: str
    track_id: str
    source: str  # "musdb" | "dsd100"


def normalize_track_id(raw: str) -> str:
    """Collapse cosmetic naming differences to one canonical track id.

    ``001 - ANiMAL - Clinic A`` and ``001_animal_clinic_a`` both become
    ``001animalclinica``.
    """
    return re.sub(r"[^a-z0-9]+", "", raw.lower())


def parse_slice(root: str, dirpath: str, filename: str) -> SliceRecord | None:
    """Return a :class:`SliceRecord` for a labeled slice, else ``None``."""
    rel_dir = os.path.relpath(dirpath, root)
    dsd = _DSD_RE.match(filename)
    if dsd:
        return SliceRecord(
            path=os.path.join(dirpath, filename),
            label=dsd.group("label").lower(),
            track_id=normalize_track_id(dsd.group("track")),
            source="dsd100",
        )
    musdb = _MUSDB_RE.match(filename)
    if musdb:
        track_dir = os.path.basename(rel_dir.rstrip(os.sep)) or rel_dir
        return SliceRecord(
            path=os.path.join(dirpath, filename),
            label=musdb.group(1).lower(),
            track_id=normalize_track_id(track_dir),
            source="musdb",
        )
    return None


def build_manifest(
    root: str = CORPUS_ROOT,
    classes: tuple[str, ...] = CLASSES,
) -> list[SliceRecord]:
    """Walk ``root`` and return every labeled slice whose label is in ``classes``."""
    records: list[SliceRecord] = []
    if not os.path.isdir(root):
        return records
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.lower().endswith(".wav"):
                continue
            rec = parse_slice(root, dirpath, name)
            if rec is not None and rec.label in classes:
                records.append(rec)
    records.sort(key=lambda r: r.path)
    return records


def summarize(records: list[SliceRecord]) -> dict[str, object]:
    """Counts by class, by source, and group overlap between the two trees."""
    by_label = Counter(r.label for r in records)
    by_source = Counter(r.source for r in records)
    tracks_by_source: dict[str, set[str]] = defaultdict(set)
    for rec in records:
        tracks_by_source[rec.source].add(rec.track_id)
    musdb_tracks = tracks_by_source.get("musdb", set())
    dsd_tracks = tracks_by_source.get("dsd100", set())
    return {
        "total_slices": len(records),
        "by_label": dict(by_label.most_common()),
        "by_source": dict(by_source.most_common()),
        "distinct_groups": len({r.track_id for r in records}),
        "musdb_groups": len(musdb_tracks),
        "dsd100_groups": len(dsd_tracks),
        "shared_groups": len(musdb_tracks & dsd_tracks),
    }


if __name__ == "__main__":
    recs = build_manifest()
    for key, value in summarize(recs).items():
        print(f"{key}: {value}")
