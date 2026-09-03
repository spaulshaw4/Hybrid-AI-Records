"""Session-oriented broadcast packager. Reuses hash helpers; does not invent audio.

Resolves real pipeline paths (scratch unmastered, renders master_output) rather
than only ``{session}_master.wav``. Optional MP3 encode via multi_format_encoder
is best-effort — missing ffmpeg does not fail the package.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.abspath(os.path.join(_HERE, ".."))
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from scripts.build_release_package import atomic_write_json, sha256_file  # noqa: E402

STEM_ROLES = ("rhythm", "harmonic", "lead", "vocal")
DEFAULT_BASE = Path(os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets"))


def _load_blueprint_meta(session_dir: Path, session_id: str) -> dict:
    candidates = [
        session_dir / f"{session_id}_blueprint.json",
        session_dir / "blueprint.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        meta = data.get("track_metadata") or {}
        return {
            "title": meta.get("title") or session_id,
            "bpm": meta.get("bpm"),
            "key": meta.get("root_key") or meta.get("key"),
            "genre": meta.get("genre"),
            "blueprint": str(path),
        }
    return {"title": session_id, "bpm": None, "key": None, "genre": None}


def resolve_masters(session_id: str, scratch: Path, renders: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    candidates = [
        ("unmastered_mix", scratch / session_id / "unmastered_mix.wav"),
        ("unmastered_named", scratch / session_id / f"{session_id}_unmastered.wav"),
        ("master_output", renders / session_id / "master_output.wav"),
        ("session_master_wav", scratch / session_id / f"{session_id}_master.wav"),
        ("session_master_mp3", scratch / session_id / f"{session_id}_master.mp3"),
        ("render_master_mp3", renders / session_id / "master_output.mp3"),
        ("render_named_wav", renders / session_id / f"{session_id}_master.wav"),
        ("render_named_mp3", renders / session_id / f"{session_id}_master.mp3"),
    ]
    for key, path in candidates:
        if path.is_file():
            found[key] = path
    return found


def _try_encode_mp3(wav: Path, dest_mp3: Path) -> str:
    scripts = os.path.join(_PARENT, "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    try:
        from multi_format_encoder import encode_master_formats, FfmpegMissingError
    except Exception:
        return "encoder-import-failed"
    try:
        encode_master_formats(str(wav), title=wav.stem, out_dir=str(dest_mp3.parent))
        return "encoded"
    except Exception as exc:
        name = type(exc).__name__
        if "FfmpegMissing" in name or "ffmpeg" in str(exc).lower():
            return "ffmpeg-missing"
        return f"encode-skip ({exc})"


def _copy_plan(src: Path, dest: Path, force: bool) -> str:
    if dest.is_file() and not force:
        return "skip-existing"
    return "copy"


def _collect_stems(session_dir: Path) -> tuple[list[Path], list[str]]:
    roots = [session_dir / "session_slices", session_dir / "stems"]
    found: list[Path] = []
    warns: list[str] = []
    existing_roots = [p for p in roots if p.is_dir()]
    if not existing_roots:
        warns.append("no session_slices/ or stems/ on disk — isolated stems skipped")
        return found, warns
    for root in existing_roots:
        for role in STEM_ROLES:
            matches = sorted(root.glob(f"*{role}*"))
            if not matches:
                role_dir = root / role
                if role_dir.is_dir():
                    matches = sorted(p for p in role_dir.glob("*.wav") if p.is_file())
            wavs = [p for p in matches if p.is_file() and p.suffix.lower() in {".wav", ".mp3"}]
            if not wavs:
                warns.append(f"no isolated {role} stem under {root.name}")
                continue
            found.extend(wavs)
    return found, warns


def _instrumental(session_dir: Path) -> Path | None:
    for path in sorted(session_dir.glob("instrumental*.wav")):
        if path.is_file():
            return path
    stems_dir = session_dir / "stems"
    if stems_dir.is_dir():
        for path in sorted(stems_dir.glob("instrumental*.wav")):
            if path.is_file():
                return path
    return None


def package_session(
    session_id: str,
    scratch: Path,
    releases: Path,
    renders: Path | None = None,
    dry_run: bool = False,
    force: bool = False,
) -> dict:
    renders = renders or scratch.parent / "renders"
    session_dir = scratch / session_id
    dest_dir = releases / session_id
    masters = resolve_masters(session_id, scratch, renders)
    meta = _load_blueprint_meta(session_dir, session_id) if session_dir.is_dir() else {
        "title": session_id, "bpm": None, "key": None, "genre": None
    }

    planned: list[dict] = []
    wav_master = masters.get("master_output") or masters.get("session_master_wav") or masters.get("render_named_wav")
    mp3_master = masters.get("render_master_mp3") or masters.get("session_master_mp3") or masters.get("render_named_mp3")
    if wav_master:
        dest = dest_dir / "master_output.wav"
        planned.append({"role": "master_wav", "src": wav_master, "dest": dest, "action": _copy_plan(wav_master, dest, force)})
        if mp3_master is None:
            dest_mp3 = dest_dir / "master_output.mp3"
            if dry_run:
                planned.append({"role": "master_mp3", "src": wav_master, "dest": dest_mp3, "action": "would-encode-if-ffmpeg"})
            else:
                dest_dir.mkdir(parents=True, exist_ok=True)
                note = _try_encode_mp3(wav_master, dest_mp3)
                if dest_mp3.is_file():
                    planned.append({"role": "master_mp3", "src": dest_mp3, "dest": dest_mp3, "action": note})
                else:
                    print(f"[WARN] MP3 encode skipped: {note}")
        else:
            dest = dest_dir / "master_output.mp3"
            planned.append({"role": "master_mp3", "src": mp3_master, "dest": dest, "action": _copy_plan(mp3_master, dest, force)})
    elif mp3_master:
        dest = dest_dir / "master_output.mp3"
        planned.append({"role": "master_mp3", "src": mp3_master, "dest": dest, "action": _copy_plan(mp3_master, dest, force)})
    else:
        print("[WARN] no master WAV/MP3 found — package will contain stems/manifest only if present")

    if masters.get("unmastered_mix"):
        dest = dest_dir / "unmastered_mix.wav"
        src = masters["unmastered_mix"]
        planned.append({"role": "unmastered", "src": src, "dest": dest, "action": _copy_plan(src, dest, force)})

    stems, stem_warns = _collect_stems(session_dir) if session_dir.is_dir() else ([], ["scratch session dir missing"])
    for msg in stem_warns:
        print(f"[WARN] {msg}")
    for src in stems:
        dest = dest_dir / "stems" / src.name
        planned.append({"role": "stem", "src": src, "dest": dest, "action": _copy_plan(src, dest, force)})

    instrumental = _instrumental(session_dir) if session_dir.is_dir() else None
    if instrumental:
        dest = dest_dir / instrumental.name
        planned.append({"role": "instrumental", "src": instrumental, "dest": dest, "action": _copy_plan(instrumental, dest, force)})
    else:
        print("[WARN] no instrumental*.wav and no isolated non-vocal stems to sum — instrumental skipped")

    assets = []
    for item in planned:
        src = item["src"]
        digest = sha256_file(src) if src.is_file() else ""
        assets.append({
            "role": item["role"],
            "filename": item["dest"].name,
            "sha256": digest,
            "action": item["action"],
        })
        print(f"  [{item['action']}] {item['role']} {item['src']} -> {item['dest']}")

    manifest = {
        "session_id": session_id,
        "title": meta.get("title"),
        "bpm": meta.get("bpm"),
        "key": meta.get("key"),
        "genre": meta.get("genre"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "assets": assets,
        "dryRun": dry_run,
    }
    if dry_run:
        print("[DRY-RUN] release_manifest.json not written")
        return manifest
    dest_dir.mkdir(parents=True, exist_ok=True)
    for item in planned:
        if item["action"] != "copy":
            continue
        item["dest"].parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item["src"], item["dest"])
    atomic_write_json(dest_dir / "release_manifest.json", manifest)
    print(f"[SUCCESS] {dest_dir / 'release_manifest.json'}")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Package a session into releases/{session}")
    parser.add_argument("--session", required=True)
    parser.add_argument("--scratch", default=str(DEFAULT_BASE / "scratch"))
    parser.add_argument("--releases", default=str(DEFAULT_BASE / "releases"))
    parser.add_argument("--renders", default=str(DEFAULT_BASE / "renders"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        package_session(
            args.session,
            Path(args.scratch),
            Path(args.releases),
            Path(args.renders),
            dry_run=args.dry_run,
            force=args.force,
        )
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
