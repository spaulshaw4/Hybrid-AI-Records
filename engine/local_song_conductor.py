"""Local algorithmic song conductor: Intro → Verse → Build → Drop.

This is the arrangement brain Stephen asked for by name. Given a prompt,
genre, tempo, and duration, it builds a chronological section map with a
per-section mute/gain vector for the four parallel buses (drums/rhythm, bass,
harmonic, vocal). The assembler then tiles **one loop per bus per section**
(8-bar lock *within* a section, 20 ms equal-power + ZC at joins) — it does
not collage packs horizontally.

Seeded RNG
----------
Every structural choice (which IVBD variant, bar counts, pre-drop, fill,
per-bus gain jitter, loop-variant index) is drawn from ``random.Random(seed)``.
The same seed reproduces the identical map; a different seed does not.

Genre / energy
--------------
If ``config/dsp_matrix.json`` (or ``D:\\MusicDatasets\\database\\dsp_matrix.json``)
loads, family energy-gamma, bus bias, and RMS targets come from
``engine.genre_arrangement_profiles``. If the matrix is absent, the documented
defaults below are used. The *skeleton* is always Intro→Verse→Build→Drop,
with a second verse and/or outro when duration allows.

Index honesty (``D:\\MusicDatasets\\db\\corpus_index.sqlite``, 52,725 rows)
-------------------------------------------------------------------------
Census 2026-08-31:

* ``stem_type`` has **no bass**: harmonic 27,944 / rhythm 13,126 /
  vocal 10,811 / lead 844 / bass 0.
* Bass files exist as *filenames* (11,572 ``bass_s4_*.wav``, all filed
  harmonic) plus a handful of ``808`` names. There are zero ``sub`` filenames.
  Selection therefore matches filename/tags (``bass``, ``808``, ``sub``) and,
  if that pool is empty, falls back to harmonic rows with a low spectral
  centroid (< 450 Hz).
* ``detected_key`` is a **pitch class only** (no maj/min). ``A`` is 17,158
  rows (32.5 %) and is the likely detection fallback — match on pitch class,
  never on mode.
"""
from __future__ import annotations

import os
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.arrangement_brain import (  # noqa: E402
    apply_arrangement_to_blueprint,
    arrangement_signature,
    build_arrangement,
    derive_seed,
    describe_arrangement,
)
from engine.genre_arrangement_profiles import (  # noqa: E402
    BUSES,
    arrangement_profile,
    load_dsp_matrix,
    slugify_genre,
)
from engine.genre_key_defaults import (  # noqa: E402
    DEFAULT_KEY_SPEC,
    resolve_genre_default_key,
)
from engine.arrangement_assembler import (  # noqa: E402
    ArrangementAssembler,
    AssemblyResult,
)
from engine.song_plan import (  # noqa: E402
    GlobalSongPlan,
    beats_per_bar,
    build_song_plan,
    parse_key_scale,
    song_plan_to_dict,
)
import numpy as np  # noqa: E402

from engine.relational_mixer import (  # noqa: E402
    apply_relational_mix,
    apply_sectioned_relational_mix,
)
from engine.stem_adapter import section_sample_count  # noqa: E402
from engine.song_evaluator import SongEvaluator  # noqa: E402
from engine.regeneration_gate import (  # noqa: E402
    GateResult,
    RegenerationGatekeeper,
)
from engine.mastering_bus import MasteringBus  # noqa: E402
from engine.provenance_guard import ProvenanceGuard  # noqa: E402
from engine.stem_packager import PackageResult, StemPackager  # noqa: E402

SKELETON_NAME = "intro_verse_build_drop"
CONDUCTOR_NAME = "local_song_conductor"
BUSES = BUSES  # drums live on the rhythm bus

# Documented defaults when the genre matrix is missing. Numbers match
# ``blueprint_track_assembler.DEFAULT_BUS_TARGET_RMS`` and the "other" family.
DEFAULT_ENERGY_GAMMA = 0.90
DEFAULT_BUS_BIAS = {"rhythm": 1.00, "bass": 1.00, "harmonic": 1.00, "vocal": 1.00}
DEFAULT_BUS_TARGET_RMS = {
    "rhythm": -14.0,
    "bass": -15.5,
    "harmonic": -17.5,
    "vocal": -15.5,
}
DEFAULT_VARIANT_POOL = {"rhythm": 2, "bass": 2, "harmonic": 3, "vocal": 3}
DEFAULT_FILL_PROBABILITY = 0.55
DEFAULT_PREDROP_PROBABILITY = 0.45
DEFAULT_PREDROP_FLAVOURS = ("drums_only", "vocal_only")
DEFAULT_INTRO_BASS_OUT = 0.70
DEFAULT_BASS_CENTROID_HZ = 240.0
DEFAULT_VOCAL_CENTROID_HZ = 2600.0

# Intro → Verse → Build → Drop, then verse / outro as duration allows.
# Bar counts are 4 or 8 (drop may be 16) so an 8-bar lock fits inside a section.
CONDUCTOR_ARCHETYPES: list[list[tuple[str, tuple[int, ...]]]] = [
    [
        ("intro", (4, 8)),
        ("verse", (8,)),
        ("build", (4, 8)),
        ("drop", (8, 16)),
        ("verse", (8,)),
        ("outro", (4, 8)),
    ],
    [
        ("intro", (8,)),
        ("verse", (8, 16)),
        ("build", (8,)),
        ("drop", (16,)),
        ("outro", (4, 8)),
    ],
    [
        ("intro", (4,)),
        ("verse", (8,)),
        ("build", (4,)),
        ("drop", (8,)),
        ("verse", (8,)),
        ("build", (4,)),
        ("drop", (8,)),
        ("outro", (4,)),
    ],
]

# Full-length song form for long renders (3:30 @ 110 BPM = 96 bars):
# Intro 8 + Verse 8 | Chorus 16 | Verse 16 | Chorus 16 | Bridge 16 |
# Final Chorus 8 + Outro 8. ``_fit_to_bars`` scales it to other lengths.
FULL_SONG_ARCHETYPE: list[tuple[str, tuple[int, ...]]] = [
    ("intro", (8,)),
    ("verse", (8,)),
    ("chorus", (16,)),
    ("verse", (16,)),
    ("chorus", (16,)),
    ("bridge", (16,)),
    ("chorus", (8,)),
    ("outro", (8,)),
]
FULL_SONG_MIN_SECONDS = 150.0
FULL_SONG_SKELETON = "intro_verse_chorus_verse_chorus_bridge_outro"

INDEX_HONESTY = (
    "stem_type has no bass (harmonic 27944, rhythm 13126, vocal 10811, lead 844). "
    "Bass from filename/tags (bass_s4, 808, sub) or harmonic low-centroid fallback. "
    "Keys are pitch class only; A is 32.5% (likely fallback) -- match pitch class, not maj/min."
)

REQUIRED_ROLES = ("intro", "verse", "build", "drop")


def _documented_default_profile(genre: str | None) -> dict[str, Any]:
    slug = slugify_genre(genre)
    return {
        "genre": slug or "unknown",
        "family": "conductor_default",
        "label": "Conductor default (Intro→Verse→Build→Drop)",
        "archetypes": [list(arc) for arc in CONDUCTOR_ARCHETYPES],
        "bus_bias": dict(DEFAULT_BUS_BIAS),
        "bus_target_rms_dbfs": dict(DEFAULT_BUS_TARGET_RMS),
        "variant_pool": dict(DEFAULT_VARIANT_POOL),
        "fill_probability": float(DEFAULT_FILL_PROBABILITY),
        "predrop_probability": float(DEFAULT_PREDROP_PROBABILITY),
        "predrop_flavours": tuple(DEFAULT_PREDROP_FLAVOURS),
        "intro_bass_out_probability": float(DEFAULT_INTRO_BASS_OUT),
        "energy_gamma": float(DEFAULT_ENERGY_GAMMA),
        "bass_centroid_hz": float(DEFAULT_BASS_CENTROID_HZ),
        "vocal_centroid_hz": float(DEFAULT_VOCAL_CENTROID_HZ),
        "mastering_source": "documented_defaults",
    }


def conduct_profile(genre: str | None) -> dict[str, Any]:
    """Energy curve + bus bias from the genre matrix, IVBD skeleton always.

    The compiled matrix is mastering-only (EQ / compressor / drive). When it
    loads, family energy-gamma and bus RMS targets are reused. When it does
    not, the documented defaults in this module are used. Either way the
    section list is Intro→Verse→Build→Drop (plus verse/outro as needed).
    """
    matrix = load_dsp_matrix()
    if matrix.get("profiles"):
        profile = arrangement_profile(genre, matrix)
        profile["archetypes"] = [list(arc) for arc in CONDUCTOR_ARCHETYPES]
        return profile
    return _documented_default_profile(genre)


def resolve_final_key(
    cli_key: str | None,
    plan: GlobalSongPlan | dict[str, Any] | None = None,
    *,
    default: str | None = None,
    genre: str | None = None,
    prompt: str | None = None,
    seed: int | None = None,
) -> tuple[str, str]:
    """CLI key wins; else plan key/scale; else genre-aware major/minor default.

    Returns ``(root, scale)`` suitable for ``GlobalSongPlan`` / blueprint meta.
    """
    if cli_key:
        return parse_key_scale(str(cli_key))
    plan_key = None
    plan_scale = None
    if isinstance(plan, GlobalSongPlan):
        plan_key = plan.key
        plan_scale = plan.scale
    elif isinstance(plan, dict):
        plan_key = plan.get("key") or plan.get("root_key")
        plan_scale = plan.get("scale")
    if plan_key:
        combined = f"{plan_key}_{plan_scale}" if plan_scale else str(plan_key)
        return parse_key_scale(combined)
    fallback = default or resolve_genre_default_key(genre, prompt, seed=seed)
    return parse_key_scale(fallback)


def apply_key_override(
    song_plan: GlobalSongPlan,
    cli_key: str | None,
    *,
    genre: str | None = None,
    prompt: str | None = None,
    seed: int | None = None,
) -> GlobalSongPlan:
    """Lock ``song_plan`` to the resolved key (frozen model → ``model_copy``).

    Without an explicit CLI key, keeps the plan key (already genre-mapped in
    ``build_song_plan``) or falls back to a genre default — never a hard-coded
    universal E minor.
    """
    if cli_key:
        final_key = cli_key
    elif getattr(song_plan, "key", None):
        final_key = f"{song_plan.key}_{song_plan.scale}"
    else:
        final_key = resolve_genre_default_key(
            genre,
            prompt,
            seed=seed if seed is not None else int(getattr(song_plan, "seed", 0) or 0),
        )
    root, scale_mode = parse_key_scale(str(final_key))
    core = dict(song_plan.core_metadata or {})
    core["key"] = f"{root}_{scale_mode}"
    return song_plan.model_copy(update={"key": root, "scale": scale_mode, "core_metadata": core})


def conduct_arrangement(
    prompt: str,
    genre: str | None,
    bpm: float,
    duration_sec: float | None = None,
    *,
    seed: int | None = None,
    request_id: str | None = None,
    explicit_seed: int | None = None,
    key: str | None = None,
    scale: str | None = None,
) -> dict[str, Any]:
    """Build a seeded Intro→Verse→Build→Drop map with per-section bus gains.

    Long renders (``duration_sec >= FULL_SONG_MIN_SECONDS``) use the full
    verse/chorus/bridge form instead, scaled to the requested bar count.
    """
    profile = conduct_profile(genre)
    full_song = bool(duration_sec and float(duration_sec) >= FULL_SONG_MIN_SECONDS)
    if full_song:
        profile["archetypes"] = [list(FULL_SONG_ARCHETYPE)]
        # Pre-drops steal bars from verses; the full form already has contrast.
        profile["predrop_probability"] = 0.0
    arrangement = build_arrangement(
        prompt,
        genre,
        bpm,
        duration_sec,
        seed=seed,
        request_id=request_id,
        explicit_seed=explicit_seed,
        profile=profile,
    )
    arrangement["conductor"] = CONDUCTOR_NAME
    arrangement["skeleton"] = FULL_SONG_SKELETON if full_song else SKELETON_NAME
    arrangement["index_honesty"] = INDEX_HONESTY
    if full_song:
        shape_full_song_dynamics(arrangement)
    # Global Song Plan is built BEFORE any SQLite stem query. Section bar
    # lengths follow the arrangement brain so the assembler stays aligned.
    song_plan = build_song_plan(
        prompt,
        genre,
        seed=int(arrangement.get("seed") or 0),
        request_id=str(arrangement.get("request_id") or ""),
        bpm=float(arrangement.get("bpm") or bpm),
        key=key,
        scale=scale,
        arrangement_sections=arrangement.get("sections") or [],
        total_bars=int(arrangement.get("total_bars") or 0) or None,
    )
    # CLI key (or plan/genre default) is the single source of truth.
    song_plan = apply_key_override(
        song_plan,
        key,
        genre=genre,
        prompt=prompt,
        seed=int(arrangement.get("seed") or 0),
    )
    if scale and not key:
        # Explicit scale-only override when no CLI key was provided.
        song_plan = song_plan.model_copy(
            update={
                "scale": str(scale).strip().lower() or song_plan.scale,
                "core_metadata": {
                    **dict(song_plan.core_metadata or {}),
                    "key": f"{song_plan.key}_{str(scale).strip().lower() or song_plan.scale}",
                },
            }
        )
    arrangement["song_plan"] = song_plan_to_dict(song_plan)
    print(
        f"[SONG_PLAN] key={song_plan.key}_{song_plan.scale} bpm={song_plan.bpm} "
        f"bars={song_plan.total_bars} sections={len(song_plan.sections)} "
        f"-> harmonic={song_plan.genre_blend.harmonic_complexity:.2f} "
        f"aggression={song_plan.genre_blend.spectral_aggression:.2f}"
    )
    return arrangement


def shape_full_song_dynamics(arrangement: dict[str, Any]) -> None:
    """Section contrast for the full form (mutates ``arrangement['sections']``).

    Intro: drums out, bass out, harmonic only. Verse 1: light drums, simplified
    bass. Verse 2 swaps loop variants so it is not a copy of verse 1. The last
    chorus is pushed to full level. Bridge: beat drops out, bass thinned.
    Outro: strips down toward the tail.
    """
    sections = arrangement.get("sections") or []
    pool = arrangement.get("variant_pool") or {}
    choruses = [s for s in sections if s.get("role") == "chorus"]
    verses = [s for s in sections if s.get("role") == "verse"]
    for section in sections:
        role = section.get("role")
        act = section.setdefault("bus_activation", {})
        if role == "intro":
            act["rhythm"] = 0.0
            act["bass"] = 0.0
            act["vocal"] = 0.0
            section["fill_bars"] = []
        elif role == "bridge":
            act["rhythm"] = 0.0
            act["bass"] = round(min(float(act.get("bass", 0.0)), 0.30), 3)
            section["fill_bars"] = []
        elif role == "outro":
            act["rhythm"] = round(min(float(act.get("rhythm", 0.0)), 0.30), 3)
            act["bass"] = round(min(float(act.get("bass", 0.0)), 0.25), 3)
            act["vocal"] = 0.0
    if verses:
        act = verses[0].setdefault("bus_activation", {})
        act["rhythm"] = round(min(float(act.get("rhythm", 0.0)), 0.55), 3)
        act["bass"] = round(min(float(act.get("bass", 0.0)), 0.55), 3)
    if len(verses) >= 2:
        first = verses[0].get("bus_variant") or {}
        second = verses[1].setdefault("bus_variant", {})
        for bus in ("rhythm", "vocal", "harmonic"):
            size = max(1, int(pool.get(bus, 1)))
            if size > 1:
                second[bus] = (int(first.get(bus, 0)) + 1) % size
    if choruses:
        last = choruses[-1]
        last["energy"] = max(float(last.get("energy") or 0.0), 1.0)
        act = last.setdefault("bus_activation", {})
        for bus in ("rhythm", "bass", "harmonic"):
            act[bus] = 1.0


def describe_conducted(arrangement: dict[str, Any]) -> str:
    """Section map plus the index-honesty line, for the CLI / render report."""
    header = (
        f"conductor={arrangement.get('conductor', CONDUCTOR_NAME)} "
        f"skeleton={arrangement.get('skeleton', SKELETON_NAME)}"
    )
    return (
        header
        + "\n"
        + describe_arrangement(arrangement)
        + "\n[INDEX] "
        + str(arrangement.get("index_honesty") or INDEX_HONESTY)
    )


# Public aliases so generate_track_headless can import from one module.
apply_conducted_blueprint = apply_arrangement_to_blueprint
conduct_signature = arrangement_signature


def mix_conducted_stems(
    stems: dict,
    arrangement: dict[str, Any],
    sr: int = 44100,
):
    """Apply Module 2 relational DSP per section of the conductor's song_plan.

    Each ``SectionPlan`` window ``[start_sample, end_sample)`` (bar math with
    the plan's time signature — the same grid ``ArrangementAssembler`` locks
    sections to) is mixed with that section's ``active_stems`` and energy,
    with 20 ms blends at the boundaries. Plans without BPM / bar counts fall
    back to one window keyed on the highest-energy section.
    """
    song_plan = arrangement.get("song_plan") if isinstance(arrangement, dict) else None
    mix_intents = None
    section = None
    genre = ""
    if isinstance(song_plan, dict):
        from engine.genre_planner import genre_from_plan

        genre = genre_from_plan(song_plan)
        mix_intents = song_plan.get("mix_intents")
        n = max((np.asarray(a).shape[0] for a in stems.values() if np.asarray(a).size), default=0)
        windows = section_windows(song_plan, n, int(sr), genre=genre)
        if windows:
            return apply_sectioned_relational_mix(
                stems, int(sr), windows, mix_intents=mix_intents, genre=genre
            )
        sections = song_plan.get("sections") or []
        if sections:
            section = max(sections, key=lambda s: float(s.get("energy_level") or 0.0))
            if isinstance(section, dict) and genre and not section.get("genre"):
                section = {**section, "genre": genre, "bpm": song_plan.get("bpm")}
    return apply_relational_mix(
        stems,
        int(sr),
        mix_intents=mix_intents,
        section=section,
        genre=genre or None,
    )


def section_windows(
    song_plan: dict[str, Any],
    n_samples: int,
    sr: int,
    *,
    genre: str | None = None,
) -> list[tuple[dict[str, Any], int, int]] | None:
    """``(section, start_sample, end_sample)`` per plan section, or ``None``.

    ``end - start = int(round(bars * beats_per_bar * 60 / bpm * sr))`` with
    ``beats_per_bar`` from ``song_plan["time_signature"]``.
    """
    sections = song_plan.get("sections") or []
    bpm = float(song_plan.get("bpm") or 0.0)
    if not sections or bpm <= 0 or n_samples <= 0:
        return None
    if any(not isinstance(s, dict) or not s.get("bars") for s in sections):
        return None
    bpb = beats_per_bar(song_plan.get("time_signature"))
    if not genre:
        from engine.genre_planner import genre_from_plan

        genre = genre_from_plan(song_plan)
    windows: list[tuple[dict[str, Any], int, int]] = []
    cursor = 0
    for section in sections:
        length = section_sample_count(int(section["bars"]), bpm, int(sr), beats_per_bar=bpb)
        payload = dict(section)
        if genre and not payload.get("genre"):
            payload["genre"] = genre
        payload["bpm"] = bpm
        windows.append((payload, cursor, min(n_samples, cursor + length)))
        cursor += length
    return windows


def assemble_conducted_tracks(
    song_plan: GlobalSongPlan | dict[str, Any],
    *,
    sr: int = 44100,
    index_db: str | None = None,
    xfade_ms: float = 18.0,
    seed: int = 0,
    require_corpus: bool = True,
) -> AssemblyResult:
    """Module 4: plan-conditioned retrieval + section stitch via ArrangementAssembler.

    Production default ``require_corpus=True``: a missing critical stem raises
    instead of rendering synthetic tones. Pass ``False`` only for dry runs.
    """
    assembler = ArrangementAssembler(
        sr=int(sr),
        index_db=index_db,
        xfade_ms=float(xfade_ms),
        seed=int(seed),
        require_corpus=bool(require_corpus),
    )
    try:
        return assembler.assemble(song_plan)
    finally:
        assembler.close()


def build_arrangement_tracks(
    song_plan: GlobalSongPlan | dict[str, Any],
    **kwargs: Any,
) -> dict:
    """Public alias matching ``ArrangementAssembler.build_arrangement(song_plan)``."""
    return assemble_conducted_tracks(song_plan, **kwargs).tracks


def render_conducted_mix(
    arrangement: dict[str, Any],
    *,
    sr: int = 44100,
    index_db: str | None = None,
    report_dir: str | None = None,
    xfade_ms: float = 18.0,
    require_corpus: bool = True,
):
    """Module 4→2→3 pipe: assemble → relational mix → quality gate."""
    raw_plan = arrangement.get("song_plan") if isinstance(arrangement, dict) else None
    if not isinstance(raw_plan, dict):
        raise ValueError("arrangement.song_plan is required for render_conducted_mix")
    seed = int(arrangement.get("seed") or raw_plan.get("seed") or 0)
    assembly = assemble_conducted_tracks(
        raw_plan,
        sr=int(sr),
        index_db=index_db,
        xfade_ms=float(xfade_ms),
        seed=seed,
        require_corpus=bool(require_corpus),
    )
    mixed = mix_conducted_stems(assembly.as_mixer_stems(), arrangement, sr=int(sr))
    gated = gate_conducted_mix(
        mixed.stems,
        mixed.mix,
        arrangement,
        sr=int(sr),
        report_dir=report_dir,
    )
    return {
        "tracks": assembly.tracks,
        "assembly_trace": assembly.trace,
        "relational": mixed,
        "gate": gated,
        "stems": gated.stems,
        "mix": gated.mix,
    }


def deliver_conducted_track(
    arrangement: dict[str, Any],
    *,
    project_dir: str,
    sr: int = 44100,
    index_db: str | None = None,
    report_dir: str | None = None,
    session_id: str | None = None,
    public_base_url: str = "/api/stream",
    provenance_refs: list | None = None,
    require_corpus: bool = True,
) -> dict[str, Any]:
    """Sequential delivery pipe matching the architecture diagram::

        Plan (M1) → Assembly (M4) → Relational Mix (M2)
          → Quality Gate (M3, regen loop) → Master/Guard (M5)
          → Distribution (master.wav + stem zip + manifest.json)

    Returns mastered audio, package paths, and localized file URLs for FastAPI.
    """
    # M1 song_plan is expected on arrangement; M4→M2→M3 run inside render.
    rendered = render_conducted_mix(
        arrangement,
        sr=int(sr),
        index_db=index_db,
        report_dir=report_dir or project_dir,
        require_corpus=bool(require_corpus),
    )
    song_plan = arrangement.get("song_plan") if isinstance(arrangement, dict) else {}
    if not isinstance(song_plan, dict):
        song_plan = {}
    target_lufs = float(song_plan.get("master_lufs_target") or -14.0)
    ceiling = float(song_plan.get("true_peak_limit") or -1.0)
    bpm = float(song_plan.get("bpm") or arrangement.get("bpm") or 120.0)
    seed = int(arrangement.get("seed") or song_plan.get("seed") or 0)

    # M5 — Master Bus & Provenance Guard → Distribution Output
    # Delivery path: a master outside the LUFS window raises before packaging.
    bus = MasteringBus(target_lufs=target_lufs, ceiling_dbtp=ceiling, enforce_compliance=True)
    mastered, master_report = bus.process(rendered["mix"], int(sr))

    guard = ProvenanceGuard(index_db=index_db, bpm=bpm, sr=int(sr))
    try:
        for ref in provenance_refs or []:
            guard.register_reference(ref.get("audio"), file_path=str(ref.get("file_path") or ""))
        mastered, guarded_stems, prov_report = guard.check(
            mastered,
            stems=rendered["stems"],
            seed=seed,
            auto_remediate=True,
        )
    finally:
        guard.close()

    # Re-limit after provenance drift so delivery still meets -1.0 dBTP.
    if prov_report.transforms_applied:
        mastered, master_report = bus.process(mastered, int(sr))

    packager = StemPackager(
        project_dir, sr=int(sr), public_base_url=public_base_url
    )
    package = packager.package(
        master=mastered,
        stems=guarded_stems,
        song_plan=song_plan,
        mastering=master_report,
        provenance=prov_report,
        session_id=session_id,
        extra_manifest={
            "pipeline": [
                "plan",
                "assembly",
                "relational_mix",
                "evaluation_gate",
                "mastering_guard",
                "distribution",
            ],
            "quality": rendered["gate"].to_report()
            if hasattr(rendered["gate"], "to_report")
            else {},
        },
    )
    return {
        **rendered,
        "master": mastered,
        "mastering": master_report,
        "provenance": prov_report,
        "package": package,
        "urls": package.urls,
        "manifest": package.manifest,
    }


def gate_conducted_mix(
    stems: dict,
    mix,
    arrangement: dict[str, Any],
    sr: int = 44100,
    *,
    report_dir: str | None = None,
    regenerate_fn=None,
    max_retries: int = 2,
    check_loudness: bool = False,
) -> GateResult:
    """Module 3 gatekeeper: evaluate after RelationalMixer, write quality_report.json.

    Localized retries only touch failing stem/section bars (up to ``max_retries``).
    Validated sections are preserved byte-for-byte in the returned stems/mix.
    """
    song_plan = arrangement.get("song_plan") if isinstance(arrangement, dict) else None
    if not isinstance(song_plan, dict):
        song_plan = {}
    plan_lufs = float(song_plan.get("master_lufs_target") or -14.0)
    plan_tp = float(song_plan.get("true_peak_limit") or -1.0)
    # Pre-master (default): loudness / true-peak compliance belongs to
    # Module 5, so the gate judges harmony and spectral balance only.
    gate = RegenerationGatekeeper(
        evaluator=SongEvaluator(
            lufs_target=plan_lufs,
            true_peak_limit=plan_tp,
            check_loudness=bool(check_loudness),
        ),
        max_retries=int(max_retries),
    )
    return gate.run(
        stems,
        mix,
        int(sr),
        song_plan=song_plan,
        regenerate_fn=regenerate_fn,
        report_dir=report_dir,
        report_name="quality_report.json",
    )


if __name__ == "__main__":  # pragma: no cover - manual inspection helper
    import argparse

    parser = argparse.ArgumentParser(description="Print a seeded conductor map")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--genre", default=None)
    parser.add_argument("--bpm", type=float, default=120.0)
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--request-id", default=None)
    parser.add_argument(
        "--key",
        default=None,
        help="Explicit key override (e.g. Dmin, G_major). Wins over genre default.",
    )
    args = parser.parse_args()
    # final_key = cli key or plan/genre default — applied inside conduct_arrangement
    plan = conduct_arrangement(
        args.prompt,
        args.genre,
        args.bpm,
        args.duration,
        request_id=args.request_id,
        explicit_seed=args.seed,
        key=args.key,
    )
    print(describe_conducted(plan))
