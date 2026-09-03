"""Compile the live genre DSP matrix cache from repo slugs + workstation profiles.

This is not a synthetic 520-row table. The mastering console list lives in
``src/lib/master-genre-matrix.ts`` (578 unique slugs at the time of writing).
Workstation profiles live in ``D:\\MusicDatasets\\scripts\\genre_master_profiles.py``
(``resolve_profile`` / ``GENRE_MASTER_PROFILES``) and the generated
``genre_matrix_profiles.py`` (500 prefix×root curves). Remaining console slugs
inherit family BASE_PROFILES derived from those live roots — curated keys are
never overwritten.

Default outputs:
  * ``D:\\MusicDatasets\\database\\dsp_matrix.json`` when D: is mounted
  * ``config/dsp_matrix.json`` in the repo (generated; gitignored)

Prints the actual compiled count. Do not assume 520.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPTS_DIR, ".."))
WORKSTATION_SCRIPTS = os.environ.get("HYBRID_SCRIPTS_DIR", r"D:\MusicDatasets\scripts")
WORKSTATION_OUT = r"D:\MusicDatasets\database\dsp_matrix.json"
REPO_OUT = os.path.join(REPO_ROOT, "config", "dsp_matrix.json")
TS_MATRIX = os.path.join(REPO_ROOT, "src", "lib", "master-genre-matrix.ts")
DEFAULT_CEILING_DBTP = -0.50
DEFAULT_TARGET_RMS = -12.0

# Family fallbacks derived from genre_master_profiles / generate_genre_matrix
# ROOTS (House, Metal, Jazz, Cinematic, …). Used only when a console slug has
# no curated, alias, matrix, quadrant, or calibration entry.
FAMILY_BASE_PROFILES: dict[str, dict[str, Any]] = {
    "Electronic / Club": {
        "sub_gain_db": 2.5,
        "mid_cut_db": -1.0,
        "drive": 1.12,
        "mono_below_hz": 130.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Solid-State",
    },
    "Rock / Metal": {
        "sub_gain_db": 2.0,
        "mid_cut_db": -1.5,
        "drive": 1.15,
        "mono_below_hz": 120.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Tube",
    },
    "Hip-Hop / R&B": {
        "sub_gain_db": 3.2,
        "mid_cut_db": 0.0,
        "drive": 1.12,
        "mono_below_hz": 140.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Soft-Clip",
    },
    "Pop / Dance": {
        "sub_gain_db": 1.5,
        "mid_cut_db": -1.0,
        "drive": 1.08,
        "mono_below_hz": 115.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Tube",
    },
    "Jazz / Roots": {
        "sub_gain_db": 0.8,
        "mid_cut_db": 0.5,
        "drive": 1.02,
        "mono_below_hz": 80.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Class-A",
    },
    "World / Latin": {
        "sub_gain_db": 2.8,
        "mid_cut_db": -1.0,
        "drive": 1.08,
        "mono_below_hz": 130.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Tape",
    },
    "Cinematic / Ambient": {
        "sub_gain_db": 2.0,
        "mid_cut_db": 0.0,
        "drive": 1.01,
        "mono_below_hz": 70.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Ultra-Lin",
    },
    "Other": {
        "sub_gain_db": 1.5,
        "mid_cut_db": 0.0,
        "drive": 1.08,
        "mono_below_hz": 120.0,
        "mono_sub": True,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": "Neutral",
    },
}

RESOLVER_FAMILY_TO_TS = {
    "electronic": "Electronic / Club",
    "metal": "Rock / Metal",
    "rock": "Rock / Metal",
    "hiphop": "Hip-Hop / R&B",
    "pop": "Pop / Dance",
    "jazz": "Jazz / Roots",
    "acoustic": "Jazz / Roots",
    "world": "World / Latin",
    "ambient": "Cinematic / Ambient",
    "classical": "Cinematic / Ambient",
}

_FAMILY_BLOCK = re.compile(r'family:\s*"([^"]+)"\s*,\s*slugs:\s*\[(.*?)\]', re.S)
_EXTRA_BLOCK = re.compile(r"const EXTRA_SLUGS = \[(.*?)\]", re.S)
_QUOTED = re.compile(r'"([^"]+)"')


def slugify(name: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", str(name).lower())
    return text.strip("_")


def _ensure_import_paths() -> list[str]:
    searched = []
    if SCRIPTS_DIR not in sys.path:
        sys.path.insert(0, SCRIPTS_DIR)
    searched.append(SCRIPTS_DIR)
    if os.path.isdir(WORKSTATION_SCRIPTS):
        if WORKSTATION_SCRIPTS not in sys.path:
            sys.path.insert(0, WORKSTATION_SCRIPTS)
        searched.append(WORKSTATION_SCRIPTS)
    return searched


def parse_ts_genre_matrix(ts_path: str) -> tuple[list[str], dict[str, str]]:
    """Return (sorted unique slugs, slug -> TS family). EXTRA slugs map to Other."""
    if not os.path.isfile(ts_path):
        raise FileNotFoundError(ts_path)
    text = open(ts_path, encoding="utf-8").read()
    family_of: dict[str, str] = {}
    slugs: set[str] = set()
    for family, body in _FAMILY_BLOCK.findall(text):
        for raw in _QUOTED.findall(body):
            key = slugify(raw)
            if not key:
                continue
            slugs.add(key)
            family_of.setdefault(key, family)
    extra_match = _EXTRA_BLOCK.search(text)
    if extra_match:
        for raw in _QUOTED.findall(extra_match.group(1)):
            key = slugify(raw)
            if not key:
                continue
            slugs.add(key)
            family_of.setdefault(key, "Other")
    return sorted(slugs), family_of


def _band_tuple(band: Any) -> tuple[str, float, float, float] | None:
    if isinstance(band, (list, tuple)) and len(band) >= 3:
        kind = str(band[0])
        hz = float(band[1])
        gain = float(band[2])
        q = float(band[3]) if len(band) > 3 else 1.0
        return kind, hz, gain, q
    return None


def flatten_live_profile(profile: dict, source: str, family: str, slug: str) -> dict[str, Any]:
    bands = profile.get("eq_bands") or []
    sub_gain = 0.0
    mid_cut = 0.0
    parsed_bands: list[list[Any]] = []
    for band in bands:
        item = _band_tuple(band)
        if item is None:
            continue
        kind, hz, gain, q = item
        parsed_bands.append([kind, hz, gain, q])
        if kind == "low_shelf" and sub_gain == 0.0:
            sub_gain = gain
        elif kind == "peaking" and mid_cut == 0.0:
            mid_cut = gain

    saturation = profile.get("saturation") or {}
    drive = saturation.get("drive")
    if drive is None and "q2_drive" in profile:
        # Quadrant drive is a different scale (≈1.2–5). Keep it labelled.
        drive = float(profile["q2_drive"])
        sat_label = "quadrant"
    else:
        drive = float(drive if drive is not None else FAMILY_BASE_PROFILES[family]["drive"])
        sat_label = str(saturation.get("label") or FAMILY_BASE_PROFILES[family].get("sat_label") or "Neutral")

    if "q1_bass_gain_db" in profile and sub_gain == 0.0:
        sub_gain = float(profile["q1_bass_gain_db"])
    mono_hz = profile.get("mono_below_hz")
    if mono_hz is None:
        mono_hz = profile.get("q1_mono_cutoff_hz")
    mono_hz = float(mono_hz if mono_hz is not None else FAMILY_BASE_PROFILES[family]["mono_below_hz"])
    ceiling = profile.get("ceiling_dbtp")
    if ceiling is None:
        ceiling = profile.get("q4_ceiling_dbfs")
    ceiling = float(ceiling if ceiling is not None else DEFAULT_CEILING_DBTP)

    row: dict[str, Any] = {
        "slug": slug,
        "family": family,
        "source": source,
        "sub_gain_db": round(float(sub_gain), 3),
        "mid_cut_db": round(float(mid_cut), 3),
        "drive": round(float(drive), 4),
        "mono_below_hz": round(float(mono_hz), 2),
        "mono_sub": float(mono_hz) > 0,
        "target_rms_dbfs": DEFAULT_TARGET_RMS,
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": sat_label,
    }
    if parsed_bands:
        row["eq_bands"] = parsed_bands
    if isinstance(profile.get("compressor"), dict):
        row["compressor"] = dict(profile["compressor"])
    if abs(ceiling - DEFAULT_CEILING_DBTP) > 1e-6:
        row["live_ceiling_dbtp"] = round(ceiling, 3)
        # Delivery cache always documents the −0.50 dBTP gate; keep the live
        # value beside it so a tighter/looser quadrant ceiling is not lost.
    return row


def family_base_row(slug: str, family: str) -> dict[str, Any]:
    base = dict(FAMILY_BASE_PROFILES.get(family) or FAMILY_BASE_PROFILES["Other"])
    return {
        "slug": slug,
        "family": family,
        "source": "family_base",
        "sub_gain_db": base["sub_gain_db"],
        "mid_cut_db": base["mid_cut_db"],
        "drive": base["drive"],
        "mono_below_hz": base["mono_below_hz"],
        "mono_sub": bool(base["mono_sub"]),
        "target_rms_dbfs": base["target_rms_dbfs"],
        "ceiling_dbtp": DEFAULT_CEILING_DBTP,
        "sat_label": base.get("sat_label", "Neutral"),
    }


def load_live_registries() -> dict[str, Any]:
    _ensure_import_paths()
    info: dict[str, Any] = {
        "curated": {},
        "aliases": {},
        "matrix": {},
        "quadrant": {},
        "resolve_profile": None,
        "family_of": None,
        "import_errors": [],
    }
    try:
        from genre_master_profiles import (  # type: ignore
            GENRE_ALIASES,
            GENRE_MASTER_PROFILES,
            resolve_profile,
        )

        info["curated"] = dict(GENRE_MASTER_PROFILES)
        info["aliases"] = dict(GENRE_ALIASES)
        info["resolve_profile"] = resolve_profile
    except Exception as exc:
        info["import_errors"].append(f"genre_master_profiles: {exc}")

    try:
        from genre_matrix_profiles import GENRE_MATRIX_PROFILES  # type: ignore

        info["matrix"] = dict(GENRE_MATRIX_PROFILES)
    except Exception as exc:
        info["import_errors"].append(f"genre_matrix_profiles: {exc}")

    try:
        from genre_quadrant_engine import GENRE_PROFILES  # type: ignore

        info["quadrant"] = dict(GENRE_PROFILES)
    except Exception as exc:
        info["import_errors"].append(f"genre_quadrant_engine: {exc}")

    try:
        from genre_resolver import family_of  # type: ignore

        info["family_of"] = family_of
    except Exception as exc:
        info["import_errors"].append(f"genre_resolver: {exc}")

    return info


def load_calibrations() -> dict[str, dict]:
    roots = [
        os.environ.get("HYBRID_CALIBRATION_DIR", r"D:\MusicDatasets\config\genre_calibrations"),
        os.path.join(REPO_ROOT, "config", "genre_calibrations"),
    ]
    found: dict[str, dict] = {}
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            if not name.endswith(".json"):
                continue
            path = os.path.join(root, name)
            try:
                with open(path, encoding="utf-8") as handle:
                    payload = json.load(handle)
            except (OSError, json.JSONDecodeError):
                continue
            key = slugify(payload.get("genre") or os.path.splitext(name)[0])
            if key:
                found[key] = payload
    return found


def apply_calibration(row: dict[str, Any], overlay: dict) -> None:
    recommended = overlay.get("recommended") or {}
    if "target_rms_dbfs" in recommended:
        row["target_rms_dbfs"] = float(recommended["target_rms_dbfs"])
    if "true_peak_ceiling_dbtp" in recommended:
        row["ceiling_dbtp"] = float(recommended["true_peak_ceiling_dbtp"])
    trim = recommended.get("saturation_drive_trim")
    if trim is not None:
        row["drive"] = round(float(row["drive"]) + float(trim), 4)
        row["drive_trim"] = float(trim)
    metrics = overlay.get("metrics")
    if isinstance(metrics, dict):
        row["calibration_metrics"] = metrics
    row["calibration"] = True


def resolve_ts_family(slug: str, ts_families: dict[str, str], family_of) -> str:
    family = ts_families.get(slug, "Other")
    if family != "Other":
        return family
    if family_of is None:
        return family
    try:
        mapped = family_of(slug)
    except Exception:
        mapped = None
    return RESOLVER_FAMILY_TO_TS.get(mapped or "", family)


def lookup_live_row(
    slug: str,
    family: str,
    registries: dict[str, Any],
) -> dict[str, Any] | None:
    curated = registries["curated"]
    aliases = registries["aliases"]
    matrix = registries["matrix"]
    quadrant = registries["quadrant"]

    if slug in curated:
        return flatten_live_profile(curated[slug], "curated", family, slug)
    if slug in aliases and aliases[slug] in curated:
        row = flatten_live_profile(curated[aliases[slug]], "alias", family, slug)
        row["resolved_as"] = aliases[slug]
        return row
    if slug in matrix:
        return flatten_live_profile(matrix[slug], "matrix", family, slug)
    if slug in quadrant:
        return flatten_live_profile(quadrant[slug], "quadrant", family, slug)

    resolver = registries.get("resolve_profile")
    if resolver is None:
        return None
    try:
        name, profile = resolver(slug)
    except Exception:
        return None
    if not profile or not name:
        return None
    # resolve_profile falls back to "reference" for unknown slugs. That is not
    # a curated hit for this slug — leave it for family BASE fill.
    if name == "reference" and slug not in ("reference", "multi"):
        return None
    source = "curated" if name in curated else "resolved"
    row = flatten_live_profile(profile, source, family, slug)
    if name != slug:
        row["resolved_as"] = name
    return row


def compile_dsp_matrix(
    ts_path: str = TS_MATRIX,
    include_extra_live_keys: bool = True,
) -> dict[str, Any]:
    slugs, ts_families = parse_ts_genre_matrix(ts_path)
    registries = load_live_registries()
    calibrations = load_calibrations()
    family_of = registries.get("family_of")

    inventory = list(slugs)
    if include_extra_live_keys:
        extras = set(registries["curated"]) | set(registries["quadrant"])
        extras |= set(registries["aliases"].values())
        for key in sorted(extras):
            key = slugify(key)
            if key and key not in ts_families:
                inventory.append(key)
                ts_families[key] = resolve_ts_family(key, ts_families, family_of)

    profiles: dict[str, dict[str, Any]] = {}
    counts = {
        "ts_slugs": len(slugs),
        "curated": 0,
        "alias": 0,
        "matrix": 0,
        "quadrant": 0,
        "resolved": 0,
        "family_base": 0,
        "calibrated": 0,
        "extra_live_keys": max(0, len(inventory) - len(slugs)),
    }

    for slug in inventory:
        family = resolve_ts_family(slug, ts_families, family_of)
        row = lookup_live_row(slug, family, registries)
        if row is None:
            row = family_base_row(slug, family)
        source = row["source"]
        if source in counts:
            counts[source] += 1
        if slug in calibrations:
            apply_calibration(row, calibrations[slug])
            counts["calibrated"] += 1
        profiles[slug] = row

    payload = {
        "meta": {
            "count": len(profiles),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "note": (
                "Compiled from live Hybrid AI Forge sources. "
                f"Console slug list is {counts['ts_slugs']} entries, not a synthetic 520 table."
            ),
            "sources": {
                "ts_matrix": os.path.abspath(ts_path) if os.path.isfile(ts_path) else None,
                "curated_profiles": len(registries["curated"]),
                "matrix_profiles": len(registries["matrix"]),
                "quadrant_profiles": len(registries["quadrant"]),
                "calibrations": len(calibrations),
                "import_errors": registries["import_errors"],
            },
            "breakdown": counts,
            "ceiling_dbtp": DEFAULT_CEILING_DBTP,
            "target_rms_dbfs": DEFAULT_TARGET_RMS,
        },
        "profiles": profiles,
    }
    return payload


def default_output_paths() -> tuple[list[str], list[str]]:
    paths: list[str] = []
    warnings: list[str] = []
    d_root = r"D:\MusicDatasets"
    if os.path.isdir(d_root):
        paths.append(WORKSTATION_OUT)
    else:
        warnings.append(
            f"workstation volume {d_root} is not mounted; skipping {WORKSTATION_OUT}"
        )
    paths.append(REPO_OUT)
    return paths, warnings


def write_matrix(payload: dict[str, Any], path: str) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".dsp_matrix_", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
    parser = argparse.ArgumentParser(
        description=(
            "Compile the live genre DSP matrix from TS slugs + workstation "
            "profiles. Prints the actual count (not a hard-coded 520)."
        )
    )
    parser.add_argument(
        "--out",
        action="append",
        default=None,
        help="Output JSON path (repeatable). Default: D: database path + repo config/",
    )
    parser.add_argument(
        "--min-count",
        type=int,
        default=None,
        help="Fail if the compiled profile count is below this number",
    )
    parser.add_argument(
        "--ts",
        default=TS_MATRIX,
        help="Path to master-genre-matrix.ts",
    )
    parser.add_argument(
        "--console-only",
        action="store_true",
        help="Do not add curated/quadrant keys that are absent from the TS slug list",
    )
    args = parser.parse_args(argv)

    try:
        payload = compile_dsp_matrix(ts_path=args.ts, include_extra_live_keys=not args.console_only)
    except FileNotFoundError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1

    count = int(payload["meta"]["count"])
    breakdown = payload["meta"]["breakdown"]
    print(f"[MATRIX] compiled {count} profiles")
    print(
        f"[MATRIX] TS slugs={breakdown['ts_slugs']}  curated={breakdown['curated']}  "
        f"alias={breakdown['alias']}  matrix={breakdown['matrix']}  "
        f"quadrant={breakdown['quadrant']}  family_base={breakdown['family_base']}  "
        f"calibrated={breakdown['calibrated']}"
    )
    if count == 520:
        print("[NOTE] count happens to be 520; this is measured, not assumed.")
    elif count != 520:
        print(f"[NOTE] live count is {count}, not the 520 figure from older copy.")

    for err in payload["meta"]["sources"]["import_errors"]:
        print(f"[WARN] {err}")

    if args.min_count is not None and count < args.min_count:
        print(f"[ERROR] compiled {count} < --min-count {args.min_count}", file=sys.stderr)
        return 1

    if args.out:
        destinations = args.out
        warnings: list[str] = []
    else:
        destinations, warnings = default_output_paths()
    for warning in warnings:
        print(f"[WARN] {warning}")
    for path in destinations:
        write_matrix(payload, path)
        print(f"[WROTE] {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
