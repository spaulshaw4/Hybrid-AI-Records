"""Build + verify Module 5 delivery pack for a live session."""
from __future__ import annotations

import glob
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.mastering_bus import MasteringBus
from engine.provenance_guard import ProvenanceGuard
from engine.song_evaluator import measure_integrated_lufs, measure_true_peak
from engine.stem_packager import STEM_FILES, StemPackager, export_delivery_bundle

session = sys.argv[1] if len(sys.argv) > 1 else "ht_904f5296ab11"
scratch = Path(rf"C:\live_web_outputs\scratch\{session}")
master_candidates = [
    Path(rf"C:\live_web_outputs\releases\assets\{session}.wav"),
    Path(rf"C:\live_web_outputs\renders\{session}\master_output.wav"),
    Path(rf"C:\live_web_outputs\releases\{session}\master_output.wav"),
    scratch / "unmastered_mix.wav",
    scratch / f"{session}_unmastered.wav",
]
master = next((p for p in master_candidates if p.is_file()), None)
print("MASTER_SRC", master)
if not master:
    raise SystemExit("no master found")

audio, sr = sf.read(str(master), always_2d=True)
audio = np.asarray(audio, dtype=np.float64)
print(f"raw_shape={audio.shape} sr={sr}")
print(f"raw_LUFS={measure_integrated_lufs(audio, sr):.3f}")
print(f"raw_dBTP={measure_true_peak(audio, sr):.3f}")

bp_path = scratch / f"{session}_blueprint.json"
song_plan: dict = {}
if bp_path.is_file():
    bp = json.loads(bp_path.read_text(encoding="utf-8"))
    song_plan = ((bp.get("arrangement") or {}).get("song_plan")) or {}
    meta = bp.get("track_metadata") or {}
    if not song_plan:
        song_plan = {
            "title": meta.get("title"),
            "key": meta.get("root_key") or meta.get("key"),
            "scale": meta.get("scale"),
            "bpm": meta.get("bpm"),
            "genre_blend": (bp.get("arrangement") or {}).get("genre_vector") or {},
        }
    # Prefer serialized GlobalSongPlan fields when present.
    if "genre_blend" not in song_plan and isinstance(song_plan.get("genre_vector"), dict):
        song_plan["genre_blend"] = song_plan["genre_vector"]
    print("PLAN_KEY", song_plan.get("key"), song_plan.get("scale"), "BPM", song_plan.get("bpm"))
    print("GENRE_VECTOR", song_plan.get("genre_blend") or song_plan.get("genre_vector"))

bus = MasteringBus(target_lufs=-14.0, ceiling_dbtp=-1.0)
mastered, report = bus.process(audio, int(sr))
print(
    f"mastered_LUFS={report.integrated_lufs:.3f} "
    f"within_0.5={abs(report.integrated_lufs + 14.0) <= 0.5}"
)
print(
    f"mastered_dBTP={report.true_peak_dbtp:.3f} "
    f"under_ceiling={report.true_peak_dbtp <= -0.95}"
)

n = mastered.shape[0]


def load_role(prefix: str) -> np.ndarray:
    paths = sorted(glob.glob(str(scratch / "session_slices" / f"{prefix}_*.wav")))
    if not paths:
        return np.zeros((n, 2), dtype=np.float64)
    chunks: list[np.ndarray] = []
    total = 0
    while total < n:
        for p in paths:
            x, _ = sf.read(p, always_2d=True)
            x = np.asarray(x, dtype=np.float64)
            chunks.append(x)
            total += x.shape[0]
            if total >= n:
                break
    cat = np.concatenate(chunks, axis=0)[:n]
    if cat.shape[1] == 1:
        cat = np.repeat(cat, 2, axis=1)
    return cat


stems = {
    "rhythm": load_role("rhythm"),
    "bass": load_role("bass"),
    "harmonic": load_role("harmonic"),
    "vocal": load_role("vocal"),
}
guard = ProvenanceGuard(bpm=float(song_plan.get("bpm") or 124), sr=int(sr))
mastered2, stems2, prov = guard.check(mastered, stems=stems, seed=0, auto_remediate=True)
if prov.transforms_applied:
    mastered2, report = bus.process(mastered2, int(sr))

# Explicit directory creation check (same helper used by packager).
delivery_dir, stems_dir = export_delivery_bundle(session, output_root=str(scratch))
# Use delivery/ as the pack root to match the brief layout.
out_dir = scratch / "delivery"
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "stems").mkdir(parents=True, exist_ok=True)

pkg = StemPackager(str(out_dir), sr=int(sr)).package(
    master=mastered2,
    stems=stems2,
    song_plan=song_plan,
    mastering=report,
    provenance=prov,
    session_id=session,
)
print("DELIVERY", out_dir)
print("TOP_LEVEL", sorted(p.name for p in out_dir.iterdir()))
print("STEMS", sorted(p.name for p in (out_dir / "stems").iterdir()))
print("ZIP", Path(pkg.zip_path).name, "BYTES", os.path.getsize(pkg.zip_path))
print("PROV_HASH", prov.certification_hash)
print("PROV_SIM", prov.max_similarity, "CERTIFIED", prov.certified)

master_path = out_dir / "master.wav"
m, msr = sf.read(str(master_path), always_2d=True)
lufs = measure_integrated_lufs(m, msr)
dbtp = measure_true_peak(m, msr)
print(f"VERIFY master.wav LUFS={lufs:.3f} dBTP={dbtp:.3f}")

assert (out_dir / "master.mp3").is_file(), "master.mp3 missing"
assert (out_dir / "manifest.json").is_file()
assert (out_dir / f"{session}_stems_bundle.zip").is_file()

manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
print("MANIFEST_KEYS", sorted(manifest.keys()))
sp = manifest.get("song_plan") or {}
print("MANIFEST_SONG_PLAN", bool(sp), "key", sp.get("key"), "bpm", sp.get("bpm"))
print("MANIFEST_GENRE_VECTOR", manifest.get("genre_vector"))
print("MANIFEST_LOUDNESS", manifest.get("loudness"))
print("MANIFEST_PROV_HASH", manifest.get("provenance_certification_hash"))
print("MANIFEST_PROV_SIM", manifest.get("provenance_similarity_score"))

lengths = {}
for name in STEM_FILES:
    p = out_dir / "stems" / name
    assert p.is_file(), name
    x, xsr = sf.read(str(p), always_2d=True)
    lengths[name] = int(x.shape[0])
    print(
        f"STEM stems/{name}: n={x.shape[0]} ch={x.shape[1]} sr={xsr} "
        f"peak={float(np.max(np.abs(x))):.4f}"
    )

assert len(set(lengths.values())) == 1, lengths
assert lengths["drums.wav"] == m.shape[0]

pass_lufs = abs(lufs - (-14.0)) <= 0.5
pass_dbtp = dbtp <= -1.0 + 1e-6
pass_manifest = all(
    k in manifest
    for k in (
        "song_plan",
        "loudness",
        "provenance_similarity_score",
        "provenance_certification_hash",
    )
) and manifest["loudness"].get("integrated_lufs") is not None
pass_layout = all(
    [
        (out_dir / "master.wav").is_file(),
        (out_dir / "master.mp3").is_file(),
        (out_dir / "manifest.json").is_file(),
        (out_dir / "stems").is_dir(),
        (out_dir / f"{session}_stems_bundle.zip").is_file(),
    ]
)

print("PASS_LUFS", pass_lufs, f"delta={lufs + 14.0:.3f}")
print("PASS_DBTP", pass_dbtp, f"dbtp={dbtp:.3f}")
print("PASS_MANIFEST", pass_manifest)
print("PASS_LAYOUT", pass_layout)
print("PASS_STEMS", True, "n", m.shape[0])
print("EXPORT_HELPER_OK", delivery_dir.is_dir() and stems_dir.is_dir())

if not (pass_lufs and pass_dbtp and pass_manifest and pass_layout):
    raise SystemExit(1)
print("ALL_CHECKS_PASSED")
