"""CPU Worker handoff: frozen v1.0.0 brain + scratch-folder probe.

Job 2 (Worker) loads ``models/release/stem_classifier_v1.0.0.pt`` read-only on
CPU. It never opens the GPU learner file. Call ``assert_handoff_ready`` after
generation and before composition so an empty ghost folder cannot reach the
master pipeline.
"""

from __future__ import annotations

import os
from typing import Any

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PRODUCTION_CKPT = os.path.join(REPO, "models", "release", "stem_classifier_v1.0.0.pt")
STAGING_ROOT = r"C:\staging_slices"
LOCKED_ROOT = r"D:\MusicDatasets\mtg\corpus_4s_dsp_locked"
CORPUS_ROOT = r"D:\MusicDatasets\corpus_4s"
LIVE_OUTPUT_ROOT = os.environ.get("HYBRID_LIVE_OUTPUT", r"C:\live_web_outputs")
MIN_MIX_BYTES = 4096


def live_output_tree() -> dict[str, str]:
    """Web-traffic writes only. Never write .rpp / mixes into C:\\staging_slices."""
    tree = {
        "root": LIVE_OUTPUT_ROOT,
        "scratch": os.path.join(LIVE_OUTPUT_ROOT, "scratch"),
        "renders": os.path.join(LIVE_OUTPUT_ROOT, "renders"),
        "releases": os.path.join(LIVE_OUTPUT_ROOT, "releases"),
        "rpp": os.path.join(LIVE_OUTPUT_ROOT, "rpp"),
        "logs": os.path.join(LIVE_OUTPUT_ROOT, "logs"),
    }
    for path in tree.values():
        os.makedirs(path, exist_ok=True)
    return tree

_brain: Any = None
_brain_info: dict[str, Any] | None = None


def _dir_has_wavs(path: str, max_dirs: int = 48) -> bool:
    if not os.path.isdir(path):
        return False
    seen = 0
    try:
        for _root, _dirs, files in os.walk(path):
            if any(name.lower().endswith(".wav") for name in files):
                return True
            seen += 1
            if seen >= max_dirs:
                break
    except OSError:
        return False
    return False


def resolve_worker_corpus() -> str:
    """Prefer NVMe staging, then locked D:, then the raw 4s corpus."""
    for path in (STAGING_ROOT, LOCKED_ROOT, CORPUS_ROOT):
        if _dir_has_wavs(path):
            return path
    return STAGING_ROOT if os.path.isdir(STAGING_ROOT) else CORPUS_ROOT


def load_production_brain() -> dict[str, Any]:
    """Load the frozen release checkpoint on CPU. Safe to call more than once."""
    global _brain, _brain_info
    if _brain_info is not None:
        return dict(_brain_info)
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["HYBRID_INFER_DEVICE"] = "cpu"
    if not os.path.isfile(PRODUCTION_CKPT):
        raise FileNotFoundError(f"Production brain missing: {PRODUCTION_CKPT}")
    latest = os.path.join(REPO, "models", "checkpoints", "stem_classifier_latest.pt")
    if os.path.normcase(os.path.abspath(PRODUCTION_CKPT)) == os.path.normcase(
        os.path.abspath(latest)
    ):
        raise RuntimeError("Worker refused to open stem_classifier_latest.pt (Learner file).")
    from engine.engine_stem_classifier import EngineStemClassifier

    engine = EngineStemClassifier(
        checkpoint_path=PRODUCTION_CKPT,
        device="cpu",
        smooth_window=1,
    )
    _brain = engine
    _brain_info = {
        "path": PRODUCTION_CKPT,
        "device": str(engine.device),
        "epoch": engine.loaded_epoch,
        "phase": engine.loaded_phase,
        "mtime": os.path.getmtime(PRODUCTION_CKPT),
        "bytes": os.path.getsize(PRODUCTION_CKPT),
        "read_only": True,
    }
    return dict(_brain_info)


def session_paths(scratch_root: str, session_id: str) -> dict[str, str]:
    session_dir = os.path.join(scratch_root, session_id)
    return {
        "session_dir": session_dir,
        "mix": os.path.join(session_dir, "unmastered_mix.wav"),
        "named_mix": os.path.join(session_dir, f"{session_id}_unmastered.wav"),
        "slices": os.path.join(session_dir, "session_slices"),
        "blueprint": os.path.join(session_dir, f"{session_id}_blueprint.json"),
    }


def inspect_handoff(scratch_root: str, session_id: str) -> dict[str, Any]:
    paths = session_paths(scratch_root, session_id)
    mix = paths["mix"]
    slices = paths["slices"]
    mix_bytes = os.path.getsize(mix) if os.path.isfile(mix) else 0
    slice_count = 0
    if os.path.isdir(slices):
        try:
            slice_count = sum(
                1
                for name in os.listdir(slices)
                if name.lower().endswith((".wav", ".flac", ".mp3"))
            )
        except OSError:
            slice_count = 0
    return {
        **paths,
        "mix_exists": os.path.isfile(mix),
        "mix_bytes": mix_bytes,
        "slice_count": slice_count,
        "blueprint_exists": os.path.isfile(paths["blueprint"]),
    }


def assert_handoff_ready(scratch_root: str, session_id: str) -> dict[str, Any]:
    """Refuse composition when generation left an empty ghost folder."""
    probe = inspect_handoff(scratch_root, session_id)
    print(
        "[HANDOFF] generation -> composition "
        f"session={session_id} mix_exists={probe['mix_exists']} "
        f"mix_bytes={probe['mix_bytes']} slices={probe['slice_count']} "
        f"blueprint={probe['blueprint_exists']} mix={probe['mix']}",
        flush=True,
    )
    if not probe["mix_exists"] or int(probe["mix_bytes"]) < MIN_MIX_BYTES:
        raise RuntimeError(
            "Composition has nothing to give: unmastered mix is missing or empty. "
            f"session={session_id} mix={probe['mix']} bytes={probe['mix_bytes']} "
            f"slices={probe['slice_count']}"
        )
    if int(probe["slice_count"]) == 0 and not probe["blueprint_exists"]:
        raise RuntimeError(
            "Composition ghost folder: session_slices is empty and no blueprint "
            f"was written for {session_id} under {probe['session_dir']}"
        )
    return probe
