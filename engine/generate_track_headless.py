"""Headless generate entry.

The live path calls Replicate ``google/lyria-3-pro`` and writes that audio as
the session master. ``execute_prompt_pipeline`` still assembles the 13-lane
tape for tests; ``main`` does not call it.
"""
from __future__ import annotations

import argparse
import http.client
import os
import re
import shutil
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from random import Random
from typing import Any

import soundfile as sf

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.abspath(os.path.join(_HERE, ".."))
for _path in (_PARENT, _HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from engine.blueprint_schema import validate_blueprint  # noqa: E402
from engine.blueprint_track_assembler import (  # noqa: E402
    DEFAULT_BPM,
    DEFAULT_PHRASE_BARS,
    SHORT_PHRASE_BARS,
    apply_r128_normalize,
    assemble_from_blueprint,
    bars_to_seconds,
    collect_corpus_wavs,
    default_index_db,
    preferred_phrase_bars,
    samples_per_bar,
    section_bar_count,
)
from engine.local_song_conductor import (  # noqa: E402
    apply_arrangement_to_blueprint,
    conduct_arrangement,
    derive_seed,
    describe_conducted,
    index_honesty,
)
from engine.gemini_arranger import (  # noqa: E402
    DEFAULT_REPLICATE_MODEL,
    arrange_from_prompt,
    lyric_replicate_token,
    replicate_token,
    write_blueprint,
)
from engine.stem_role_router import split_pool_by_layer  # noqa: E402

from db.sample_indexer import index_count, resolve_corpus_bank  # noqa: E402
from engine.slice_rotator import query_rotated_bank  # noqa: E402

STEMS = ("rhythm", "harmonic", "lead", "vocal")
STAGE_STEMS = STEMS + ("bass",)
PITCH_STEMS = frozenset({"harmonic", "lead", "vocal", "bass"})
DEFAULT_CORPUS = r"D:\MusicDatasets\corpus_4s"
DEFAULT_SCRATCH = os.environ.get("HYBRID_SCRATCH") or r"C:\live_web_outputs\scratch"
SLICE_SECONDS = 4.0
BASS_QUERY_TAGS = ["bass", "808", "sub"]
FETCH_MULTIPLIER = 8


def _layer_kind(path: str) -> str | None:
    """MUSDB-style filename roles. ``None`` = generic / unit-test slice."""
    name = os.path.basename(path).lower()
    if name.startswith("mixture") or "mixture_" in name:
        return "mixture"
    if name.startswith("drums") or name.startswith("drum_") or "drums_" in name:
        return "drums"
    if "bass" in name:
        return "bass"
    if name.startswith("other") or "other_" in name:
        return "other"
    if name.startswith("vocals") or name.startswith("vocal_"):
        return "vocals"
    return None


def _keep_for_stem(stem: str, path: str) -> bool:
    kind = _layer_kind(path)
    if kind == "mixture":
        return False
    if stem == "rhythm":
        return kind in (None, "drums")
    if stem == "harmonic":
        return kind in (None, "other")
    if stem == "lead":
        return kind in (None, "other")
    if stem == "vocal":
        return kind in (None, "vocals")
    if stem == "bass":
        return kind == "bass"
    return True


def _filter_stem_paths(stem: str, paths: list[str]) -> list[str]:
    return [path for path in paths if _keep_for_stem(stem, path)]


def session_scratch_dir(scratch_dir: str, session_id: str) -> str:
    root = os.path.abspath(scratch_dir)
    if os.path.basename(root.rstrip("\\/")) == session_id:
        return root
    return os.path.join(root, session_id)


def _collect_capped(corpus_dir: str, cap: int) -> list[str]:
    if not os.path.isdir(corpus_dir):
        return []
    found: list[str] = []
    try:
        for entry in os.scandir(corpus_dir):
            if entry.is_file() and entry.name.lower().endswith(".wav"):
                found.append(entry.path)
                if len(found) >= cap:
                    return found
    except OSError:
        return []
    if len(found) < 6:
        for path in collect_corpus_wavs(corpus_dir):
            if path not in found:
                found.append(path)
            if len(found) >= cap:
                break
    return found


def _glob_fallback_banks(corpus_dir: str, max_per_stem: int, max_stage: int) -> dict[str, list[str]]:
    files = _collect_capped(corpus_dir, cap=max(max_stage * 2, 32))
    layers = split_pool_by_layer(files) if files else {}
    cap = max(1, int(max_per_stem))
    banks: dict[str, list[str]] = {}
    for stem in STEMS:
        pool = layers.get(stem) or layers.get("unknown") or files
        filtered = _filter_stem_paths(stem, pool)
        banks[stem] = list(filtered or pool)[:cap]
    bass_hits = _filter_stem_paths("bass", files)
    if not bass_hits:
        bass_hits = [path for path in files if "bass" in os.path.basename(path).lower()]
    banks["bass"] = bass_hits[:cap]
    return banks


_CLI_KEY_RE = re.compile(
    r"^([A-Ga-g](?:#|b|♯|♭)?)(minor|min|major|maj|dorian|dor|phrygian|phr|m)?$",
    re.IGNORECASE,
)


def _blueprint_scale(meta: dict[str, Any]) -> str:
    raw = meta.get("scale") or meta.get("mode") or meta.get("scale_mode") or "minor"
    token = str(raw).strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "maj": "major",
        "ionian": "major",
        "min": "minor",
        "m": "minor",
        "aeolian": "minor",
        "dor": "dorian",
        "phr": "phrygian",
    }
    return aliases.get(token, token or "minor")


def parse_cli_key(raw: str | None) -> tuple[str | None, str | None]:
    """Parse ``--key Dmin`` / ``D minor`` into (root_note, scale)."""
    if raw is None:
        return None, None
    compact = re.sub(r"[\s\-_]+", "", str(raw).strip())
    if not compact:
        return None, None
    match = _CLI_KEY_RE.match(compact)
    if not match:
        return str(raw).strip(), None
    root = match.group(1)
    rest = (match.group(2) or "").strip()
    scale = _blueprint_scale({"scale": rest}) if rest else None
    return root, scale


def apply_cli_bpm_key(
    blueprint: dict[str, Any],
    bpm: float | None,
    key: str | None,
) -> None:
    """Write CLI tempo/key onto track_metadata (scale survives validate via restore)."""
    meta = blueprint.setdefault("track_metadata", {})
    if not isinstance(meta, dict):
        meta = {}
        blueprint["track_metadata"] = meta
    if bpm is not None:
        meta["bpm"] = float(bpm)
    if key:
        root, scale = parse_cli_key(key)
        if root:
            meta["root_key"] = root
        if scale:
            meta["scale"] = scale


ALIGN_LOSS_TOLERANCE_DB = 12.0


def _rms_dbfs(audio: Any) -> float:
    import numpy as np

    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(arr))))
    if rms < 1e-12:
        return -120.0
    return float(20.0 * np.log10(rms))


def _keep_if_not_gutted(
    processed: Any,
    previous: Any,
    label: str,
    *,
    allow_level_drop: bool = False,
) -> Any:
    """Reject an alignment stage that silenced or badly gutted the slice.

    Guard against a DSP stage returning near-silence from usable audio. A
    staged stem that is silent produces a silent bus, which is exactly the
    "vocal is not there" symptom this pipeline is meant to have fixed.
    """
    before = _rms_dbfs(previous)
    after = _rms_dbfs(processed)
    if before <= -119.0:
        return processed
    if after <= -119.0 or (
        not allow_level_drop and (before - after) > ALIGN_LOSS_TOLERANCE_DB
    ):
        print(
            f"[STAGE] {label} dropped level {before:.1f} -> {after:.1f} dBFS; "
            "keeping the unprocessed audio"
        )
        return previous
    return processed


def _stage_aligned_copy(
    src_path: str,
    dest_path: str,
    stem: str,
    target_key: str,
    target_bpm: float,
    target_scale: str = "minor",
) -> bool:
    if os.path.isfile(dest_path):
        return False
    try:
        audio, sr = sf.read(src_path, always_2d=True)
    except Exception:
        return False
    if _rms_dbfs(audio) <= -119.0:
        # A silent source can never become a usable layer.
        return False
    try:
        from dsp.tempo_time_stretch import lock_slice_to_tempo

        audio = _keep_if_not_gutted(
            lock_slice_to_tempo(
                audio,
                target_bpm=float(target_bpm),
                sr=int(sr),
                original_bpm=None,
            ),
            audio,
            f"tempo lock {os.path.basename(src_path)} -> {float(target_bpm):.3f} BPM",
            allow_level_drop=True,
        )
    except Exception:
        pass
    if stem in PITCH_STEMS:
        try:
            from dsp.pitch_key_aligner import align_slice_to_target_key

            audio = _keep_if_not_gutted(
                align_slice_to_target_key(audio, target_root=target_key, sr=int(sr)),
                audio,
                f"key align {os.path.basename(src_path)}",
            )
        except Exception:
            pass
    if stem == "vocal":
        try:
            from dsp.vocal_pitch_corrector import tune_vocal_buffer

            audio = _keep_if_not_gutted(
                tune_vocal_buffer(audio, sr=int(sr), key=target_key, scale=target_scale),
                audio,
                f"vocal tune {os.path.basename(src_path)}",
            )
        except Exception:
            pass
    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    sf.write(dest_path, audio, int(sr), subtype="PCM_24")
    return True


SELECTOR_ROLES = ("rhythm", "bass", "harmonic", "vocal")


def stage_scored_session_cache(
    blueprint: dict[str, Any],
    db_path: str,
    session_corpus_dir: str,
    corpus_dir: str,
    rng: Random,
    arrangement: dict[str, Any],
    max_per_stem: int = 8,
    max_stage: int = 64,
    reproducible: bool = False,
    memory: Any = None,
) -> int:
    """Stage slices chosen by musical fit, not by whichever row came back first.

    Candidates are scored on key compatibility, tempo distance inside the
    0.5-2.0 WSOLA stretch clamp, spectral centroid role fit, and level, then
    picked score-weighted through the seeded RNG so two requests for the same
    genre land on different (but still fitting) stems. ``slice_history`` is
    updated so the cooldown pushes later requests elsewhere in the corpus.

    ``reproducible=True`` (set when the caller passed an explicit ``--seed``)
    takes the render history out of the loop entirely: candidates are ordered
    by ``file_path``, the use-count nudge is skipped, and ``slice_history`` is
    left untouched. Cooldown rotation and exact reproducibility are genuinely
    in conflict - a seed cannot pin a selection that depends on how many times
    the corpus has been rendered since - so the explicit seed wins.
    """
    import sqlite3

    from engine.slice_rotator import mark_slices_used
    from engine.stem_selector import describe_selection, pack_id_from_path, select_for_role

    os.makedirs(session_corpus_dir, exist_ok=True)
    # Reusing a session id with a new seed must not leave last render's stems
    # on disk: the assembler globs this directory, so stale files would end up
    # as loop variants that this arrangement never scored or chose.
    for stale in os.listdir(session_corpus_dir):
        if stale.lower().endswith(".wav"):
            try:
                os.remove(os.path.join(session_corpus_dir, stale))
            except OSError:
                pass

    meta = blueprint.get("track_metadata") or {}
    target_key = str(meta.get("root_key") or "A")
    target_scale = _blueprint_scale(meta if isinstance(meta, dict) else {})
    target_bpm = float(meta.get("bpm") or 120)

    pool = arrangement.get("variant_pool") or {}
    centroid_targets = {
        "bass": float(arrangement.get("bass_centroid_hz") or 250.0),
        "vocal": float(arrangement.get("vocal_centroid_hz") or 2600.0),
    }

    # Global Song Plan constraints (built before this SQLite pass).
    song_plan = arrangement.get("song_plan") if isinstance(arrangement, dict) else None
    plan_energy = 0.55
    pitch_weights = None
    plan_chords: list[str] = []
    if isinstance(song_plan, dict):
        sections = song_plan.get("sections") or []
        energies = [
            float(s.get("energy_level") or 0.5)
            for s in sections
            if isinstance(s, dict)
        ]
        if energies:
            plan_energy = sum(energies) / len(energies)
        if song_plan.get("key"):
            target_key = str(song_plan["key"])
        if song_plan.get("bpm"):
            target_bpm = float(song_plan["bpm"])
        print(
            f"[SONG_PLAN] retrieve bpm={target_bpm:.0f} key={target_key} "
            f"energy={plan_energy:.2f} sections={len(sections)}",
            flush=True,
        )
        # Score candidates on the notes they contain, against the chords this
        # song actually holds, rather than on a single detected_key label.
        try:
            from engine.musical_features import plan_pitch_weights
            from engine.musical_index import coverage

            plan_chords = [
                str(step.get("chord"))
                for step in (song_plan.get("harmonic_roadmap") or [])
                if isinstance(step, dict) and step.get("chord")
            ]
            if plan_chords:
                weights = plan_pitch_weights(plan_chords)
                if float(weights.sum()) > 0.0:
                    pitch_weights = weights
                    rows = coverage().get("musical_rows", 0)
                    print(
                        f"[HARMONY] progression={len(set(plan_chords))} distinct chords; "
                        f"chroma available for {rows} slices",
                        flush=True,
                    )
        except Exception as exc:
            print(f"[HARMONY] chord-aware selection unavailable ({exc})", flush=True)

    # Rhythmic context. Without one the groove weight has nothing to compare a
    # candidate's measured accent grid against and never moves a ranking. The
    # genre's arrangement family carries that opinion (four-on-the-floor vs
    # backbeat vs tresillo); roles with no bar-level accent pattern resolve to
    # None so the weight redistributes rather than scoring them all alike.
    groove_targets: dict[str, Any] = {}
    grammar = None
    try:
        from engine.genre_arrangement_profiles import (
            family_for_genre,
            grammar_rhythm_target,
            groove_target_for_role,
            resolve_genre_grammar,
        )

        family = str((arrangement or {}).get("family") or "") or family_for_genre(
            str(meta.get("genre") or "")
        )
        groove_targets = {
            role: groove_target_for_role(family, role) for role in SELECTOR_ROLES
        }
        grammar = resolve_genre_grammar(str(meta.get("genre") or (arrangement or {}).get("genre") or ""))
        rhythm_grid = grammar_rhythm_target(grammar)
        if rhythm_grid is not None:
            groove_targets["rhythm"] = rhythm_grid
        print(
            f"[GRAMMAR] archetype={grammar.archetype} grid={grammar.kick_snare_grid} "
            f"priority={'>'.join(grammar.bus_priority)}",
            flush=True,
        )
        named = [role for role, target in groove_targets.items() if target]
        print(
            f"[GROOVE] family={family} targets={','.join(named) or 'none'}",
            flush=True,
        )
    except Exception as exc:
        print(f"[GROOVE] groove-aware selection unavailable ({exc})", flush=True)

    if not db_path or not os.path.isfile(db_path):
        return 0
    try:
        from engine.live_index import (
            is_source_index,
            live_index_path,
            open_live_index,
            resolve_worker_index,
        )

        if is_source_index(db_path):
            db_path = resolve_worker_index()
        if os.path.normcase(os.path.abspath(db_path)) == os.path.normcase(
            os.path.abspath(live_index_path())
        ):
            conn, _info = open_live_index(into_memory=True)
        else:
            conn = sqlite3.connect(db_path, timeout=5)
    except (sqlite3.Error, OSError, FileNotFoundError):
        return 0

    staged = 0
    staged_by: dict[str, int] = {role: 0 for role in STAGE_STEMS}
    anchor_pack_id = ""
    motif: dict[str, list[str]] = {}
    # Ledger of what was offered and what won. Written now because delivery
    # purges the scratch tree, so none of this is recoverable later.
    # The session corpus lives at <scratch>/<session_id>/session_slices.
    session_id = os.path.basename(os.path.dirname(os.path.abspath(session_corpus_dir)))
    ledger = None
    if session_id:
        try:
            from engine import mix_history

            ledger = mix_history.open_ledger()
            mix_history.record_session(
                ledger,
                session_id,
                prompt=str((arrangement or {}).get("prompt") or meta.get("title") or ""),
                genre=str(meta.get("genre") or ""),
                song_key=target_key,
                scale=target_scale or "",
                bpm=target_bpm,
                total_bars=int(meta.get("total_bars") or 0),
                seed=(arrangement or {}).get("seed"),
                progression=plan_chords,
                pitch_weights=pitch_weights,
                scorer="musical" if pitch_weights is not None else "legacy",
            )
        except Exception as exc:
            print(f"[LEDGER] disabled ({exc})", flush=True)
            ledger = None
    try:
        priority = grammar.bus_priority if grammar is not None else SELECTOR_ROLES
        role_order = [role for role in priority if role in SELECTOR_ROLES]
        for role in SELECTOR_ROLES:
            if role not in role_order:
                role_order.append(role)
        for role in role_order:
            if staged >= max_stage:
                break
            if role in {"harmonic", "vocal", "lead"} and (
                staged_by.get("rhythm", 0) == 0 or staged_by.get("bass", 0) == 0
            ):
                print(
                    f"[ANCHOR] {role} waits: rhythm={staged_by.get('rhythm', 0)} "
                    f"bass={staged_by.get('bass', 0)}",
                    flush=True,
                )
                continue
            # One spare beyond the variant pool so a drum fill has somewhere to go.
            want = min(int(max_per_stem), max(2, int(pool.get(role, 2)) + 1))
            print(
                f"[COMPOSITION] Arranging section {role} with anchor "
                f"{anchor_pack_id or '-'}...",
                flush=True,
            )
            print(
                f"[SELECT] scoring {role} want={want} "
                f"anchor={anchor_pack_id or '-'} db={db_path}",
                flush=True,
            )
            trace: dict[str, Any] = {}
            picks = select_for_role(
                conn,
                role,
                target_key,
                target_bpm,
                want,
                rng,
                centroid_target_hz=centroid_targets.get(role),
                energy_level=plan_energy,
                use_cooldown=not reproducible,
                anchor_pack_id=anchor_pack_id or None,
                pitch_weights=pitch_weights,
                groove_target=groove_targets.get(role),
                trace=trace if ledger is not None else None,
                fatigue_penalty=None if memory is None or reproducible else memory.penalty_for,
            )
            if not picks:
                print(f"[SELECT] {role}: no scored candidates in {os.path.basename(db_path)}")
                continue
            print(describe_selection(role, picks))
            if role == "rhythm" and picks:
                anchor_pack_id = pack_id_from_path(str(picks[0].get("file_path") or ""))
                print(f"[AFFINITY] drum_anchor_pack={anchor_pack_id or '-'}", flush=True)
            chosen_paths: list[str] = []
            for item in picks:
                if staged >= max_stage:
                    break
                src_path = str(item["file_path"])
                dest_name = f"{role}_{os.path.basename(src_path)}"
                dest_path = os.path.join(session_corpus_dir, dest_name)
                if os.path.isfile(dest_path) or _stage_aligned_copy(
                    src_path, dest_path, role, target_key, target_bpm, target_scale
                ):
                    staged += 1
                    staged_by[role] = staged_by.get(role, 0) + 1
                    chosen_paths.append(src_path)
            if chosen_paths:
                motif[role] = list(chosen_paths)
            if chosen_paths and not reproducible:
                try:
                    mark_slices_used(conn, chosen_paths)
                except Exception:
                    pass
            if ledger is not None and trace.get("ranked"):
                try:
                    from engine import mix_history

                    n = mix_history.record_decisions(
                        ledger, session_id, role, trace["ranked"], chosen_paths
                    )
                    print(
                        f"[LEDGER] {role}: logged {n} candidates, "
                        f"{len(chosen_paths)} staged",
                        flush=True,
                    )
                except Exception as exc:
                    print(f"[LEDGER] {role} write failed ({exc})", flush=True)
    finally:
        conn.close()
        if ledger is not None:
            try:
                ledger.close()
            except Exception:
                pass

    if isinstance(arrangement, dict):
        arrangement["pack_affinity"] = {
            "anchor_pack_id": anchor_pack_id,
            "slices": motif,
        }
    print(
        "[STAGE] scored per-stem "
        + " ".join(f"{role}={staged_by.get(role, 0)}" for role in SELECTOR_ROLES)
        + f" total={staged} anchor={anchor_pack_id or '-'}"
    )
    return staged


def stage_session_cache(
    blueprint: dict[str, Any],
    db_path: str,
    session_corpus_dir: str,
    corpus_dir: str,
    max_per_stem: int = 8,
    max_stage: int = 64,
) -> int:
    os.makedirs(session_corpus_dir, exist_ok=True)
    meta = blueprint.get("track_metadata") or {}
    target_key = str(meta.get("root_key") or "A")
    target_scale = _blueprint_scale(meta if isinstance(meta, dict) else {})
    target_bpm = float(meta.get("bpm") or 120)
    rows = index_count(db_path)
    use_index = rows >= 8
    staged = 0
    staged_by: dict[str, int] = {stem: 0 for stem in STAGE_STEMS}
    seen: set[str] = set()
    fetch_n = max(int(max_per_stem) * FETCH_MULTIPLIER, int(max_per_stem), 16)

    def _stage_paths(stem: str, paths: list[str]) -> None:
        nonlocal staged
        for src_path in _filter_stem_paths(stem, paths)[: max(1, int(max_per_stem))]:
            if staged >= max_stage:
                return
            dest_name = f"{stem}_{os.path.basename(src_path)}"
            dest_path = os.path.join(session_corpus_dir, dest_name)
            if dest_path in seen:
                continue
            seen.add(dest_path)
            already = os.path.isfile(dest_path)
            if already or _stage_aligned_copy(
                src_path, dest_path, stem, target_key, target_bpm, target_scale
            ):
                staged += 1
                staged_by[stem] = staged_by.get(stem, 0) + 1

    def _query_stem(stem: str, tags: list) -> list[str]:
        query_stem = "harmonic" if stem == "bass" else stem
        matched = query_rotated_bank(
            db_path,
            tags,
            query_stem,
            target_key,
            limit=fetch_n,
        )
        matched = _filter_stem_paths(stem, matched)
        if matched:
            return matched
        matched = resolve_corpus_bank(
            db_path,
            tags,
            query_stem,
            target_key,
            limit=fetch_n,
        )
        return _filter_stem_paths(stem, matched)

    if use_index:
        for section in blueprint.get("sections") or []:
            if staged >= max_stage:
                break
            tags_map = section.get("query_tags") or {}
            for stem in STEMS:
                if staged >= max_stage:
                    break
                tags = tags_map.get(stem) or []
                _stage_paths(stem, _query_stem(stem, tags))
            if staged_by.get("bass", 0) < max_per_stem and staged < max_stage:
                bass_tags = tags_map.get("bass") or BASS_QUERY_TAGS
                _stage_paths("bass", _query_stem("bass", bass_tags))

    required = ("rhythm", "harmonic", "vocal", "bass")
    if staged < 6 or any(staged_by.get(stem, 0) == 0 for stem in required):
        missing = [stem for stem in STAGE_STEMS if staged_by.get(stem, 0) == 0]
        print(
            f"[STAGE] Index rows={rows}; glob fallback for empty stems {missing} from {corpus_dir}"
        )
        banks = _glob_fallback_banks(corpus_dir, max_per_stem, max_stage)
        for stem in missing:
            if stem == "lead" and staged_by.get("harmonic", 0) > 0:
                # lead is empty in the index; harmonic already covers that role.
                continue
            _stage_paths(stem, banks.get(stem) or [])

    print(
        "[STAGE] per-stem "
        + " ".join(f"{stem}={staged_by.get(stem, 0)}" for stem in STAGE_STEMS)
        + f" total={staged}"
    )
    print(f"[*] Staged and aligned {staged} candidate slices for session.")
    return staged


def _finish_package(
    session_dir: str,
    session_id: str,
    source_trace: dict[str, Any],
    memory: Any,
    scratch: Any,
    genre: str | None,
    bpm: float,
    sr: int,
) -> str:
    """Bounce the 13 lanes into exports/song_YYYYMMDD_NNN and remember the DNA."""
    import json
    from datetime import date

    from engine.audio_exporter import (
        RenderSession,
        export_multitrack_package,
        load_console_lanes,
        package_dir_for,
    )
    from engine.stem_lanes import stem_id_of

    lanes_meta = (source_trace or {}).get("_console_lanes") or {}
    lanes, lane_sr = load_console_lanes(lanes_meta.get("files") or {})
    manifest: dict[str, Any] = {}
    manifest_path = os.path.join(session_dir, "render_manifest.json")
    if os.path.isfile(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            manifest = loaded
    if scratch is not None:
        manifest["scratch"] = scratch.to_dict()
    manifest.setdefault("song_id", session_id)
    day = date.today().strftime("%Y%m%d")
    dest = package_dir_for(session_dir, len(memory.recent(1000)) + 1, day)
    export_multitrack_package(
        RenderSession(lanes, manifest, int(lane_sr or sr)),
        dest,
    )
    stem_ids = [stem_id_of(path) for path in (lanes_meta.get("files") or {}).values() if path]
    memory.record_render(
        str(genre or ""),
        scratch.key if scratch is not None else str(manifest.get("key") or ""),
        float(scratch.bpm if scratch is not None else bpm),
        list(scratch.romans) if scratch is not None else [],
        stem_ids,
        song_id=session_id,
        form=scratch.form_id if scratch is not None else "",
        feel=scratch.rhythmic_feel if scratch is not None else "",
        swing_ms=float(scratch.swing_offset_ms) if scratch is not None else 0.0,
        progression_id=scratch.progression_id if scratch is not None else "",
        lane_dna={"package": dest, "stems": stem_ids},
    )
    return dest


def execute_prompt_pipeline(
    prompt: str,
    session_id: str,
    db_path: str,
    scratch_dir: str,
    *,
    genre: str | None = None,
    offline: bool = False,
    live: bool = False,
    corpus_dir: str = DEFAULT_CORPUS,
    max_per_stem: int = 8,
    max_stage: int = 64,
    sr: int = 44100,
    duration_sec: float | None = None,
    output_path: str | None = None,
    bpm: float | None = None,
    key: str | None = None,
    normalize_lufs: float | None = None,
    ceiling_dbtp: float = -0.5,
    seed: int | None = None,
    request_id: str | None = None,
    arrange: bool = True,
    vocal_mode: str | None = None,
    vocal_file: str | None = None,
) -> dict[str, Any]:
    session_dir = session_scratch_dir(scratch_dir, session_id)
    os.makedirs(session_dir, exist_ok=True)
    blueprint_path = os.path.join(session_dir, f"{session_id}_blueprint.json")
    unmastered_named = os.path.join(session_dir, f"{session_id}_unmastered.wav")
    unmastered_mix = os.path.join(session_dir, "unmastered_mix.wav")
    session_corpus = os.path.join(session_dir, "session_slices")

    token_present = bool(replicate_token())
    if live and not token_present:
        raise ValueError("Missing REPLICATE_API_TOKEN (--live requires a token).")
    if offline and not live:
        use_live = False
    elif live:
        use_live = True
    else:
        use_live = token_present

    try:
        from engine.live_index import is_source_index, resolve_worker_index

        if is_source_index(db_path):
            db_path = resolve_worker_index()
    except Exception:
        pass

    rows = index_count(db_path)
    print(f"[DB] {os.path.abspath(db_path)} COUNT(*)={rows}")

    blueprint, mode = arrange_from_prompt(
        prompt,
        genre,
        offline=not use_live,
        live=use_live,
    )
    blueprint = validate_blueprint(blueprint, enforce_section_span=True)
    if bpm is not None or key:
        apply_cli_bpm_key(blueprint, bpm, key)
        cli_scale = (blueprint.get("track_metadata") or {}).get("scale")
        blueprint = validate_blueprint(blueprint, enforce_section_span=True)
        if cli_scale:
            blueprint["track_metadata"]["scale"] = cli_scale
    meta = blueprint["track_metadata"]
    bpm_val = float(meta.get("bpm") or DEFAULT_BPM)
    if vocal_file and os.path.isfile(vocal_file):
        from engine.vocal_ingest import duration_from_vocal_file, song_length_from_vocal

        vocal_sec = duration_from_vocal_file(vocal_file)
        if vocal_sec > 0:
            duration_sec = song_length_from_vocal(vocal_sec, bpm_val)
            print(
                f"[API_LENGTH] vocal_sec={vocal_sec:.1f} duration_sec={duration_sec:.1f} "
                f"bars={round(duration_sec * bpm_val / 240.0)} (vocal + 8-bar outro)",
                flush=True,
            )

    resolved_seed, resolved_request = derive_seed(prompt, request_id, seed)
    arrangement: dict[str, Any] | None = None
    memory = None
    scratch = None
    try:
        from engine.arrangement_planner import EngineMemory, plan_scratch

        memory = EngineMemory(os.path.join(session_dir, "engine_memory.db"))
        if seed is None and bpm is None and not key:
            scratch = plan_scratch(str(genre or meta.get("genre") or ""), memory)
            bpm_val = float(scratch.bpm)
            meta["bpm"] = bpm_val
            print(
                f"[SCRATCH] key={scratch.key} bpm={scratch.bpm:.0f} "
                f"progression={scratch.progression_id} feel={scratch.rhythmic_feel} "
                f"swing_ms={scratch.swing_offset_ms:.0f}",
                flush=True,
            )
    except Exception as exc:
        print(f"[SCRATCH] fresh blueprint unavailable ({exc})", flush=True)
        memory = None
        scratch = None
    if arrange:
        print(
            f"[CONDUCTOR] seed mode={'explicit (reproducible)' if seed is not None else 'derived'}"
        )
        print(f"[INDEX] {index_honesty()}")
        arrangement = conduct_arrangement(
            prompt,
            genre or meta.get("genre"),
            bpm_val,
            duration_sec,
            seed=resolved_seed,
            request_id=resolved_request,
            key=key or (scratch.key if scratch is not None else None),
            scale=(blueprint.get("track_metadata") or {}).get("scale"),
        )
        if scratch is not None and isinstance(arrangement, dict):
            from engine.arrangement_planner import apply_scratch

            apply_scratch(arrangement, scratch, genre or meta.get("genre"))
            bpm_val = float(scratch.bpm)
        # Mirror resolved plan key onto blueprint before arrangement overlay.
        sp = arrangement.get("song_plan") if isinstance(arrangement, dict) else None
        if isinstance(sp, dict) and sp.get("key"):
            meta["root_key"] = str(sp["key"])
            if sp.get("scale"):
                meta["scale"] = str(sp["scale"])
        blueprint = apply_arrangement_to_blueprint(blueprint, arrangement)
        # Explicit CLI tempo/key always win over song_plan / prompt defaults.
        if bpm is not None or key:
            apply_cli_bpm_key(blueprint, bpm, key)
        # validate_blueprint rebuilds track_metadata from the contract fields,
        # which would drop CLI extras such as ``scale``. Carry them across.
        extra_meta = {
            key_name: value
            for key_name, value in (blueprint.get("track_metadata") or {}).items()
            if key_name not in {"title", "bpm", "root_key", "genre", "total_bars"}
        }
        blueprint = validate_blueprint(blueprint, enforce_section_span=False)
        blueprint["track_metadata"].update(extra_meta)
        if bpm is not None or key:
            apply_cli_bpm_key(blueprint, bpm, key)
        # Keep song_plan mirror aligned with the locked key (CLI or plan or E_minor).
        from engine.local_song_conductor import resolve_final_key

        meta_locked = blueprint.get("track_metadata") or {}
        sp = (blueprint.get("arrangement") or {}).get("song_plan")
        root, scale_mode = resolve_final_key(
            key,
            sp if isinstance(sp, dict) else None,
        )
        # Prefer already-locked blueprint root when CLI applied it.
        if meta_locked.get("root_key"):
            root = str(meta_locked["root_key"])
            scale_mode = str(meta_locked.get("scale") or scale_mode)
        meta_locked["root_key"] = root
        meta_locked["scale"] = scale_mode
        blueprint["track_metadata"] = meta_locked
        if isinstance(sp, dict):
            sp["key"] = root
            sp["scale"] = scale_mode
            if meta_locked.get("bpm"):
                sp["bpm"] = int(meta_locked["bpm"])
            if isinstance(arrangement, dict):
                arrangement["song_plan"] = sp
        print(f"[CONDUCTOR] request_id={resolved_request}")
        print(describe_conducted(arrangement))
    elif duration_sec is not None and duration_sec > 0:
        _fit_blueprint_duration(blueprint, float(duration_sec))
        blueprint = validate_blueprint(blueprint, enforce_section_span=True)

    if vocal_mode:
        blueprint.setdefault("track_metadata", {})["vocal_mode"] = str(vocal_mode)
        print(f"[VOCAL] mode={vocal_mode}")
    if vocal_file and os.path.isfile(vocal_file):
        from engine.vocal_tuner import tune_if_possible

        locked = blueprint.get("track_metadata") or {}
        root = str(locked.get("root_key") or "G")
        mode = str(locked.get("scale") or "major")
        vocal_file = tune_if_possible(vocal_file, root_key=root, mode=mode)
        blueprint.setdefault("track_metadata", {})["vocal_file"] = str(vocal_file)
        print(f"[VOCAL] file={vocal_file} key={root}_{mode}", flush=True)

    write_blueprint(blueprint, blueprint_path)
    meta = blueprint["track_metadata"]
    bpm_val = float(meta.get("bpm") or DEFAULT_BPM)
    print(
        f"[*] Blueprint locked: Key={meta['root_key']} | BPM={bpm_val} | "
        f"Sections={len(blueprint['sections'])} | mode={mode} | seed={resolved_seed}"
    )
    print(
        f"[*] Bar-lock 4/4 @ {bpm_val} BPM | samples_per_bar={samples_per_bar(sr, bpm_val)} | "
        f"8 bars={bars_to_seconds(8, bpm_val):.3f}s"
    )
    for sec in blueprint.get("sections") or []:
        bars = section_bar_count(sec, bpm_val)
        print(f"    {sec.get('name', '?')}: {bars} bars ({bars_to_seconds(bars, bpm_val):.3f}s)")

    stage_rng = Random(resolved_seed ^ 0x5F3759DF)
    compose_t0 = time.perf_counter()
    staged = 0
    source_trace: dict[str, Any] = {}
    try:
        print(
            f"[COMPOSITION] Arranging section staging with anchor "
            f"{(arrangement or {}).get('pack_affinity', {}).get('anchor_pack_id') or '-'}...",
            flush=True,
        )
        if arrangement is not None:
            staged = stage_scored_session_cache(
                blueprint,
                db_path,
                session_corpus,
                corpus_dir,
                stage_rng,
                arrangement,
                max_per_stem=max_per_stem,
                max_stage=max_stage,
                reproducible=seed is not None,
                memory=memory,
            )
        if staged < 6:
            staged = stage_session_cache(
                blueprint,
                db_path,
                session_corpus,
                corpus_dir,
                max_per_stem=max_per_stem,
                max_stage=max_stage,
            )
        if staged < 6:
            raise RuntimeError(
                f"Need at least 6 staged slices to assemble; got {staged}. "
                f"Check {corpus_dir} or run a smoke index first."
            )

        print(f"[BPM] locked={bpm_val:.3f} (UI / CLI wins over stem native tempo)", flush=True)
        # Live phrase align plans with Gemini, then resolve_blueprint_dependencies
        # synthesizes every source=generate lane before the tape stretches it.
        assemble_from_blueprint(
            blueprint_path,
            session_corpus,
            unmastered_named,
            sr=sr,
            seed=resolved_seed,
            target_key=None,
            target_bpm=float(bpm_val),
            index_db=None,
            use_index=False,
            # Session context makes the assembler write bus_stems/ next to the
            # session mix; Module 5 refuses to package without them.
            session_id=session_id,
            scratch_root=os.path.dirname(os.path.abspath(session_dir)),
            source_trace=source_trace,
            bounce_lanes=True,
            phrase_align="live" if lyric_replicate_token() else "local",
        )
        print(
            f"[COMPOSITION] elapsed_sec={time.perf_counter() - compose_t0:.2f} "
            f"staged={staged}",
            flush=True,
        )
    except Exception:
        print(
            f"[COMPOSITION] failed after {time.perf_counter() - compose_t0:.2f}s\n"
            f"{traceback.format_exc()}",
            flush=True,
        )
        raise
    else:
        if memory is not None:
            try:
                result_package = _finish_package(
                    session_dir, session_id, source_trace, memory, scratch, genre, bpm_val, sr
                )
                source_trace["_package"] = result_package
            except Exception as exc:
                print(f"[PACKAGE] {exc}", flush=True)
    finally:
        if memory is not None:
            try:
                memory.close()
            except Exception:
                pass
    if os.path.abspath(unmastered_named) != os.path.abspath(unmastered_mix):
        shutil.copy2(unmastered_named, unmastered_mix)
    mix_bytes = os.path.getsize(unmastered_mix) if os.path.isfile(unmastered_mix) else 0
    slice_count = 0
    if os.path.isdir(session_corpus):
        slice_count = sum(
            1 for name in os.listdir(session_corpus) if name.lower().endswith(".wav")
        )
    print(
        f"[HANDOFF] generation -> composition mix_bytes={mix_bytes} "
        f"slices={slice_count} staged={staged} mix={unmastered_mix}",
        flush=True,
    )
    if mix_bytes < 4096:
        raise RuntimeError(
            "Composition has nothing to give: unmastered mix is missing or empty. "
            f"bytes={mix_bytes} slices={slice_count} corpus={corpus_dir}"
        )
    if vocal_file and os.path.isfile(vocal_file):
        from engine.vocal_ingest import mix_recorded_vocal_onto_master

        mix_recorded_vocal_onto_master(unmastered_mix, vocal_file, sr=sr)
        if os.path.abspath(unmastered_named) != os.path.abspath(unmastered_mix):
            shutil.copy2(unmastered_mix, unmastered_named)
    exported = unmastered_mix
    r128_meta: dict[str, float] | None = None
    if output_path:
        exported = _export_mix(unmastered_mix, output_path, duration_sec, sr)
        print(f"[EXPORT] {exported} ({wav_duration_sec(exported):.1f}s)")
        if normalize_lufs is not None:
            audio, file_sr = sf.read(exported, always_2d=True)
            limited, lufs_val, dbtp_val = apply_r128_normalize(
                audio,
                int(file_sr or sr),
                target_lufs=float(normalize_lufs),
                ceiling_dbtp=float(ceiling_dbtp),
            )
            sf.write(exported, limited, int(file_sr or sr), subtype="PCM_24")
            r128_meta = {"lufs": lufs_val, "dbtp": dbtp_val}
            print(f"[EXPORT-R128] {exported} LUFS={lufs_val:.2f} dBTP={dbtp_val:.2f}")
    print(f"[READY FOR DSP] Assembly complete: {unmastered_mix}")
    result = {
        "blueprint_path": blueprint_path,
        "unmastered_wav": unmastered_named,
        "unmastered_mix": unmastered_mix,
        "output_wav": exported,
        "session_dir": session_dir,
        "mode": mode,
        "model": DEFAULT_REPLICATE_MODEL if mode != "offline" else None,
        "staged": staged,
        "index_rows": index_count(db_path),
        "seed": resolved_seed,
        "request_id": resolved_request,
        "source_trace": source_trace,
    }
    if arrangement is not None:
        result["arrangement"] = arrangement
    if r128_meta:
        result["r128"] = r128_meta
    if source_trace.get("_package"):
        result["package"] = source_trace["_package"]
    return result


def wav_duration_sec(path: str) -> float:
    if not os.path.isfile(path):
        return 0.0
    info = sf.info(path)
    if not info.samplerate:
        return 0.0
    return float(info.frames) / float(info.samplerate)


def _fit_blueprint_duration(blueprint: dict[str, Any], duration_sec: float) -> None:
    """Scale section bar counts so assembled length is near duration_sec (4/4 bars)."""
    sections = blueprint.get("sections") or []
    if not sections or duration_sec <= 0:
        return
    meta = blueprint.get("track_metadata") or {}
    bpm = float(meta.get("bpm") or DEFAULT_BPM) if isinstance(meta, dict) else DEFAULT_BPM
    bar_sec = bars_to_seconds(1, bpm)
    n = len(sections)
    target_bars = max(n, int(round(float(duration_sec) / bar_sec)))
    remaining = target_bars
    for i, sec in enumerate(sections):
        leftover = n - i - 1
        if leftover <= 0:
            sec["slice_count"] = max(1, remaining)
            break
        preferred = preferred_phrase_bars(sec)
        max_share = remaining - leftover
        if preferred <= max_share:
            share = preferred
        elif DEFAULT_PHRASE_BARS <= max_share:
            share = DEFAULT_PHRASE_BARS
        elif SHORT_PHRASE_BARS <= max_share:
            share = SHORT_PHRASE_BARS
        else:
            share = max(1, max_share)
        sec["slice_count"] = share
        remaining -= share
    if isinstance(meta, dict):
        meta["total_bars"] = sum(int(sec["slice_count"]) for sec in sections)


def _export_mix(src: str, dest: str, duration_sec: float | None, sr: int) -> str:
    """Copy assembled wav to dest, trimming or padding to duration_sec when set."""
    dest_abs = os.path.abspath(dest)
    parent = os.path.dirname(dest_abs)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if duration_sec is None or duration_sec <= 0:
        if os.path.abspath(src) != dest_abs:
            shutil.copy2(src, dest_abs)
        return dest_abs
    audio, file_sr = sf.read(src, always_2d=True)
    use_sr = int(file_sr or sr or 44100)
    target = int(round(float(duration_sec) * use_sr))
    if target < 1:
        if os.path.abspath(src) != dest_abs:
            shutil.copy2(src, dest_abs)
        return dest_abs
    frames = int(audio.shape[0])
    if frames > target:
        audio = audio[:target]
    elif frames < target:
        import numpy as np

        pad = np.zeros((target - frames, audio.shape[1]), dtype=audio.dtype)
        audio = np.concatenate([audio, pad], axis=0)
    sf.write(dest_abs, audio, use_sr, subtype="PCM_24")
    return dest_abs


LYRIA_PREDICTIONS_URL = "https://api.replicate.com/v1/models/google/lyria-3-pro/predictions"
LYRIA_TIMEOUT_SEC = 180.0
LYRIA_POLL_SEC = 3.0
LYRIA_GATEWAY_RETRIES = 2
LYRIA_GATEWAY_RETRY_SLEEP_SEC = 3.0
LYRIA_MASTER_RATE = 48000
# Studio lengths: 90 through 420 in steps of 30.
# At or below 210 is one Lyria pass. Above 210 continues once (two predictions).
LYRIA_DURATION_MIN_SEC = 90
LYRIA_DURATION_MAX_SEC = 420
LYRIA_DURATION_STEP_SEC = 30
LYRIA_SINGLE_PASS_MAX_SEC = 210
LYRIA_PASS1_SEC = 210
LYRIA_CONTINUATION_TAIL_SEC = 15.0
LYRIA_CROSSFADE_MS = 1000
LYRIA_CONTINUATION_INSTRUCTION = (
    "Continue the same song from its previous 15-second ending. "
    "Do not restart the intro. Treat that ending as the overlap, then continue with the remaining lyrics."
)
# One Hybrid Token ($2.00) for every accepted length, including 300s and 420s.
HYBRID_GENERATION_TOKEN_CHARGE = 1
LYRIC_SANITIZE_URL = "https://api.replicate.com/v1/models/google/gemini-2.5-flash/predictions"
LYRIC_SANITIZE_TIMEOUT_SEC = 5.0
LYRIC_SANITIZE_POLL_SEC = 0.25
LYRIC_SANITIZE_SYSTEM = (
    "You are an expert lyric adapter for Outlaw Country, Blues, and Rock. "
    "Scan the input lyrics. Preserve the exact structure, syllable counts, rhythm, "
    "and tags ([Verse], [Chorus], [Bridge]). Identify any corporate moderation "
    "tripwires—specifically alcohol brand names, direct substance words like whiskey, "
    "bourbon, jack, booze, or extreme profanity. Replace only those specific words "
    'with genre-authentic metaphors (such as "the bottle", "black label", "the pour", '
    '"rye", "the hard stuff") or safe phonetic homophones so the meter sings identically '
    "without triggering automated sensitive content filters. Output only the updated lyrics."
)
_LYRIA_TERMINAL = frozenset({"succeeded", "failed", "canceled"})


def compose_lyria_prompt(style: str = "", prompt: str = "", lyrics: str = "") -> str:
    """Style prompt, a blank line, then lyrics. Nothing is invented.

    ``style`` is the style prompt. ``prompt`` fills that role when style is
    empty, and is appended when it carries different text. A prompt that only
    repeats the lyrics is not written twice.
    """
    style_text = (style or "").strip()
    prompt_text = (prompt or "").strip()
    lyric_text = (lyrics or "").strip()
    if lyric_text and prompt_text == lyric_text:
        prompt_text = ""
    if style_text and prompt_text and prompt_text != style_text:
        head = f"{style_text}\n{prompt_text}"
    else:
        head = style_text or prompt_text
    if head and lyric_text:
        return f"{head}\n\n{lyric_text}"
    text = head or lyric_text
    if not text:
        raise ValueError("Lyria prompt is empty")
    return text


def lyria_output_url(output: Any) -> str:
    """Replicate output is an audio URL, or a one-item list of one URL."""
    if isinstance(output, str) and output.strip():
        return output.strip()
    if isinstance(output, (list, tuple)) and len(output) == 1:
        item = output[0]
        if isinstance(item, str) and item.strip():
            return item.strip()
    raise RuntimeError("Lyria output was not an audio URL")


def _audio_extension(url: str, content_type: str, body: bytes) -> str:
    head = body[:16]
    if head.startswith(b"ID3") or (
        len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0
    ):
        return ".mp3"
    if len(body) >= 12 and head.startswith(b"RIFF") and body[8:12] == b"WAVE":
        return ".wav"
    path = urllib.parse.urlparse(url).path.lower()
    if path.endswith(".mp3"):
        return ".mp3"
    if path.endswith(".wav"):
        return ".wav"
    ctype = (content_type or "").lower()
    if "mpeg" in ctype or "mp3" in ctype:
        return ".mp3"
    if "wav" in ctype or "wave" in ctype:
        return ".wav"
    return ".mp3"


def _download_lyria_audio(url: str, timeout: float) -> tuple[bytes, str]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            content_type = str(resp.headers.get("Content-Type") or "")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Lyria audio download failed: HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Lyria audio download failed: {exc.reason}") from None
    if not body:
        raise RuntimeError("Lyria audio download was empty")
    return body, content_type


def _lyria_token() -> str:
    """Hybrid Replicate token. Never the lyric engine key."""
    from engine.gemini_arranger import _load_env_quiet, replicate_token

    _load_env_quiet()
    return replicate_token()


def _as_frame_channels(audio: Any) -> Any:
    """``(frames, channels)`` float64. Librosa stereo arrives as ``(channels, frames)``."""
    import numpy as np

    arr = np.asarray(audio, dtype=np.float64)
    if arr.ndim == 1:
        return arr[:, np.newaxis]
    if arr.ndim != 2:
        raise RuntimeError("Lyria audio was not mono or stereo PCM")
    if arr.shape[0] <= 8 and arr.shape[1] > arr.shape[0]:
        arr = np.ascontiguousarray(arr.T)
    return arr


def _resample_to_rate(audio: Any, src_sr: int, dst_sr: int) -> Any:
    """Resample ``(frames, channels)`` PCM. Same-rate audio is returned unchanged."""
    import numpy as np

    arr = _as_frame_channels(audio)
    src = int(src_sr)
    dst = int(dst_sr)
    if src == dst or arr.size == 0:
        return arr
    try:
        from math import gcd
        from scipy.signal import resample_poly

        div = gcd(src, dst) or 1
        return np.asarray(resample_poly(arr, dst // div, src // div, axis=0), dtype=np.float64)
    except Exception:
        import librosa

        channels = [
            librosa.resample(np.ascontiguousarray(arr[:, ch]), orig_sr=src, target_sr=dst)
            for ch in range(arr.shape[1])
        ]
        return np.stack(channels, axis=1)


def _read_audio_array(path: str) -> tuple[Any, int]:
    """Decode a temp download. WAV uses soundfile; MP3 falls through to librosa."""
    import numpy as np

    soundfile_error: Exception | None = None
    try:
        data, sr = sf.read(path, always_2d=True, dtype="float64")
        if getattr(data, "size", 0):
            return np.asarray(data, dtype=np.float64), int(sr)
    except Exception as exc:
        soundfile_error = exc
    try:
        import librosa
    except Exception as exc:
        raise RuntimeError(f"Lyria audio could not be decoded: {soundfile_error or exc}") from exc
    try:
        loaded, sr = librosa.load(path, sr=None, mono=False)
    except Exception as exc:
        raise RuntimeError(f"Lyria audio could not be decoded: {exc}") from exc
    return _as_frame_channels(loaded), int(sr)


def _decode_lyria_download(body: bytes, url: str, content_type: str) -> Any:
    """Decode Replicate audio to mono-or-stereo float PCM at ``LYRIA_MASTER_RATE``."""
    import tempfile

    import numpy as np

    if not body:
        raise RuntimeError("Lyria audio download was empty")
    suffix = _audio_extension(url, content_type, body)
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
        audio, native_sr = _read_audio_array(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
    audio = _resample_to_rate(audio, int(native_sr), LYRIA_MASTER_RATE)
    audio = _as_frame_channels(audio)
    if audio.size == 0:
        raise RuntimeError("Lyria audio had no samples")
    if audio.shape[1] > 2:
        audio = audio[:, :2]
    if audio.shape[1] == 1:
        return np.ascontiguousarray(audio[:, 0])
    return np.ascontiguousarray(audio)


def assert_lyria_master_wav(path: str) -> None:
    """Gate 1 for a Lyria master: the file exists and is larger than 100KB.

    RIFF layout, sample rate, PCM subtype, and bar count are not checked here.
    Those belonged to the 13-lane engine. Loudness, limiter, and true-peak
    stay on the mastering path and are not part of this check.
    """
    if not path or not os.path.isfile(path):
        raise RuntimeError(f"Lyria master is missing: {path}")
    if os.path.getsize(path) <= 100 * 1024:
        raise RuntimeError(f"Lyria master must be larger than 100KB: {path}")


def _write_lyria_wav(path: str, audio: Any) -> None:
    """Write 48 kHz PCM_16. Short test tones are valid; the 100KB gate is later."""
    import numpy as np

    packed = np.clip(np.asarray(audio, dtype=np.float64), -1.0, 1.0)
    sf.write(path, packed, LYRIA_MASTER_RATE, subtype="PCM_16", format="WAV")


def _unwrap_lyric_fence(text: str) -> str:
    """Drop one outer markdown fence. Section tags inside the lyrics stay."""
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _lyric_sanitize_prediction(token: str, lyrics: str, deadline: float) -> dict:
    """POST Gemini Flash and poll until it finishes or the deadline passes."""
    from engine.gemini_arranger import _http_json

    def remaining() -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("lyric sanitize timed out")
        return left

    prediction = _http_json(
        LYRIC_SANITIZE_URL,
        token,
        {
            "input": {
                "prompt": lyrics,
                "system_instruction": LYRIC_SANITIZE_SYSTEM,
                "temperature": 0.2,
                "max_output_tokens": 4096,
                "thinking_budget": 0,
            }
        },
        timeout=remaining(),
        extra_headers={"Prefer": "wait"},
    )
    while str(prediction.get("status") or "") not in _LYRIA_TERMINAL:
        if time.monotonic() >= deadline:
            raise TimeoutError("lyric sanitize timed out")
        urls = prediction.get("urls") if isinstance(prediction.get("urls"), dict) else {}
        poll_url = str((urls or {}).get("get") or "").strip()
        if not poll_url:
            raise RuntimeError("lyric sanitize has no urls.get")
        delay = min(LYRIC_SANITIZE_POLL_SEC, deadline - time.monotonic())
        if delay <= 0:
            raise TimeoutError("lyric sanitize timed out")
        time.sleep(delay)
        if time.monotonic() >= deadline:
            raise TimeoutError("lyric sanitize timed out")
        prediction = _http_json(poll_url, token, None, timeout=remaining())
    status = str(prediction.get("status") or "")
    if status != "succeeded":
        raise RuntimeError(f"lyric sanitize {status or 'failed'}")
    return prediction


def sanitize_lyrics_for_lyria(
    lyrics: str,
    *,
    token: str,
    timeout_sec: float = LYRIC_SANITIZE_TIMEOUT_SEC,
) -> str:
    """Soften filter tripwires with Gemini Flash on the hybrid Replicate token.

    Blank lyrics are returned as they are. A preflight that exceeds
    ``timeout_sec`` or raises is logged and the original lyrics are kept so
    Lyria still runs.
    """
    original = lyrics or ""
    if not original.strip() or not (token or "").strip():
        return original
    from engine.gemini_arranger import _join_output

    deadline = time.monotonic() + float(timeout_sec)
    try:
        prediction = _lyric_sanitize_prediction(token, original, deadline)
        text = _unwrap_lyric_fence(_join_output(prediction.get("output")).strip())
        if not text:
            raise RuntimeError("Gemini returned empty lyrics")
        print("[LYRIC] sanitized lyrics for Lyria", flush=True)
        return text
    except Exception as exc:
        detail = str(exc).replace("\n", " ")[:200]
        print(
            f"[LYRIC] sanitize skipped ({detail}); using original lyrics",
            file=sys.stderr,
            flush=True,
        )
        return original


def _requests_connection_error() -> type[BaseException] | None:
    """``requests`` is optional. Missing it must not block the urllib path."""
    try:
        from requests.exceptions import ConnectionError as requests_connection_error
    except ImportError:
        return None
    return requests_connection_error


def _is_lyria_gateway_drop(exc: BaseException) -> bool:
    """True for a dropped Replicate socket, including one wrapped by urllib.

    ``requests.exceptions.ConnectionError`` and ``http.client.RemoteDisconnected``
    are the named cases. urllib raises ``URLError`` whose ``reason`` is a
    ``ConnectionError`` (``RemoteDisconnected`` is one of those).
    """
    transient: tuple[type[BaseException], ...] = (
        http.client.RemoteDisconnected,
        ConnectionError,
    )
    requests_connection_error = _requests_connection_error()
    if requests_connection_error is not None:
        transient = (*transient, requests_connection_error)
    stack: list[BaseException] = [exc]
    seen: set[int] = set()
    while stack:
        current = stack.pop()
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        if isinstance(current, transient):
            return True
        reason = getattr(current, "reason", None)
        if isinstance(reason, BaseException):
            stack.append(reason)
        if current.__cause__ is not None:
            stack.append(current.__cause__)
        if current.__context__ is not None and current.__context__ is not current.__cause__:
            stack.append(current.__context__)
    return False


def _lyria_prediction_http(http_json: Any, *args: Any, **kwargs: Any) -> dict:
    """POST or poll Lyria. Two retries, 3 seconds apart, on a gateway drop."""
    drops = 0
    while True:
        try:
            return http_json(*args, **kwargs)
        except Exception as exc:
            if drops >= LYRIA_GATEWAY_RETRIES or not _is_lyria_gateway_drop(exc):
                raise
            drops += 1
            print(
                f"[LYRIA] gateway drop ({exc.__class__.__name__}); "
                f"retry {drops}/{LYRIA_GATEWAY_RETRIES}",
                flush=True,
            )
            time.sleep(LYRIA_GATEWAY_RETRY_SLEEP_SEC)


def clamp_lyria_duration(seconds: float | None) -> int:
    """Accept 90 through 420 in steps of 30. Off-grid values are rejected. Above 420 becomes 420."""
    from services.composition import clamp_duration

    return clamp_duration(seconds)


def generation_token_charge(duration_sec: float | None = None) -> int:
    """Hybrid Tokens charged for one generation. Length never changes the price."""
    from services.composition import generation_token_charge as charge

    return charge(duration_sec)


def _lyria_prompt_audio(
    token: str,
    full_prompt: str,
    *,
    timeout_sec: float,
    poll_sec: float,
) -> tuple[Any, bytes, str, str]:
    """POST one Lyria prediction and return decoded PCM plus the download bytes."""
    from engine.gemini_arranger import _http_json

    deadline = time.monotonic() + float(timeout_sec)
    prediction = _lyria_prediction_http(
        _http_json,
        LYRIA_PREDICTIONS_URL,
        token,
        {"input": {"prompt": full_prompt}},
        timeout=min(70.0, float(timeout_sec)),
        extra_headers={"Prefer": "wait"},
    )
    while str(prediction.get("status") or "") not in _LYRIA_TERMINAL:
        if time.monotonic() > deadline:
            raise RuntimeError("Lyria prediction timed out")
        urls = prediction.get("urls") if isinstance(prediction.get("urls"), dict) else {}
        poll_url = str((urls or {}).get("get") or "").strip()
        if not poll_url:
            raise RuntimeError("Lyria prediction has no urls.get")
        time.sleep(float(poll_sec))
        if time.monotonic() > deadline:
            raise RuntimeError("Lyria prediction timed out")
        prediction = _lyria_prediction_http(_http_json, poll_url, token, None, timeout=60.0)
    status = str(prediction.get("status") or "")
    if status != "succeeded":
        err = prediction.get("error") or status or "failed"
        raise RuntimeError(f"Lyria prediction {status}: {err}")
    audio_url = lyria_output_url(prediction.get("output"))
    body, content_type = _download_lyria_audio(audio_url, timeout=60.0)
    audio = _decode_lyria_download(body, audio_url, content_type)
    return audio, body, content_type, audio_url


def _render_lyria_two_pass(
    dest_dir: str,
    *,
    style: str,
    prompt: str,
    lyrics: str,
    session_id: str,
    duration_sec: int,
    token: str,
    timeout_sec: float,
    poll_sec: float,
) -> str:
    """Two Lyria predictions and one pydub master. Pass 2 errors fail the job.

    ``part1.wav`` and ``part2.wav`` stay in the session scratch dir and are not
    published. The master is ``{session_id}_master.wav``. Lyria stays prompt-only:
    the 15s tail is the stitch overlap, not a second model input.
    """
    from services.composition import (
        continuation_block,
        extract_context_tail,
        split_lyrics_for_passes,
        stitch_lyria_master,
    )

    os.makedirs(dest_dir, exist_ok=True)
    part1_path = os.path.join(dest_dir, "part1.wav")
    part2_path = os.path.join(dest_dir, "part2.wav")
    tail_path = os.path.join(dest_dir, "part1_tail.wav")
    master_path = os.path.join(dest_dir, f"{session_id}_master.wav")
    first_lyrics, remaining_lyrics = split_lyrics_for_passes(lyrics, duration_sec)
    prompt1 = compose_lyria_prompt(style, prompt, first_lyrics)
    print("[LYRIA] pass 1 render", flush=True)
    audio1, _body1, _type1, _url1 = _lyria_prompt_audio(
        token,
        prompt1,
        timeout_sec=timeout_sec,
        poll_sec=poll_sec,
    )
    _write_lyria_wav(part1_path, audio1)
    try:
        extract_context_tail(part1_path, tail_path)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Lyria prediction failed: {exc}") from exc
    prompt2 = compose_lyria_prompt(style, prompt, continuation_block(remaining_lyrics))
    print("[LYRIA] pass 2 render", flush=True)
    try:
        audio2, _body2, _type2, _url2 = _lyria_prompt_audio(
            token,
            prompt2,
            timeout_sec=timeout_sec,
            poll_sec=poll_sec,
        )
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Lyria prediction failed: {exc}") from exc
    _write_lyria_wav(part2_path, audio2)
    try:
        stitch_lyria_master(part1_path, part2_path, master_path)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Lyria prediction failed: {exc}") from exc
    print(f"[LYRIA] exported master {master_path}", flush=True)
    return master_path


def render_lyria_master(
    dest_dir: str,
    *,
    style: str = "",
    prompt: str = "",
    lyrics: str = "",
    session_id: str = "lyria",
    timeout_sec: float = LYRIA_TIMEOUT_SEC,
    poll_sec: float = LYRIA_POLL_SEC,
    duration_sec: float | None = None,
) -> str:
    """Sanitize lyrics, POST lyria-3-pro, poll ``urls.get``, save 48 kHz PCM WAV.

    Durations of 210 seconds or less (including 90 and 180) are one prediction
    and do not write part1/part2. Anything above 210, up to 420, runs a second
    prediction, extracts the trailing 15 seconds of part1.wav, and stitches with
    ``part1.append(part2, crossfade=1000)``. Above 420 clamps to 420.
    ``num_outputs`` is not sent; each prediction body is ``{"input": {"prompt": ...}}``.

    Gemini Flash runs on ``REPLICATE_API_TOKEN`` and has a 5 second budget.
    A slow or failed preflight keeps the original lyrics. A dropped Replicate
    socket retries twice, 3 seconds apart. Returns the path of the saved
    master, always ``{session_id}_master.wav``.
    """
    token = _lyria_token()
    if not token:
        raise RuntimeError("REPLICATE_API_TOKEN is not set")
    original_lyrics = lyrics or ""
    lyrics = sanitize_lyrics_for_lyria(original_lyrics, token=token)
    if (prompt or "").strip() and (prompt or "").strip() == original_lyrics.strip():
        prompt = lyrics
    requested = None if duration_sec is None else clamp_lyria_duration(duration_sec)
    if requested is not None and requested > LYRIA_SINGLE_PASS_MAX_SEC:
        return _render_lyria_two_pass(
            dest_dir,
            style=style,
            prompt=prompt,
            lyrics=lyrics,
            session_id=session_id,
            duration_sec=requested,
            token=token,
            timeout_sec=timeout_sec,
            poll_sec=poll_sec,
        )
    full_prompt = compose_lyria_prompt(style, prompt, lyrics)
    audio, body, content_type, audio_url = _lyria_prompt_audio(
        token,
        full_prompt,
        timeout_sec=timeout_sec,
        poll_sec=poll_sec,
    )
    os.makedirs(dest_dir, exist_ok=True)
    master_path = os.path.join(dest_dir, f"{session_id}_master.wav")
    _write_lyria_wav(master_path, audio)
    # Vault MP3 download can use the original bytes. A failed sidecar must not
    # block Gate 1, which only opens the WAV.
    if _audio_extension(audio_url, content_type, body) == ".mp3":
        raw_mp3 = os.path.join(dest_dir, f"{session_id}_master.mp3")
        try:
            with open(raw_mp3, "wb") as handle:
                handle.write(body)
        except OSError:
            pass
    return master_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Headless prompt-to-unmastered mix")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--session", default="headless_session_01")
    parser.add_argument(
        "--db",
        default=None,
        help="Slice index. Default: C:\\live_web_outputs\\db\\corpus_index_live.sqlite",
    )
    parser.add_argument("--scratch", default=DEFAULT_SCRATCH)
    parser.add_argument(
        "--corpus",
        default=None,
        help="Slice corpus. Default: C:\\staging_slices, then locked D:, then corpus_4s.",
    )
    parser.add_argument("--genre", default=None)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--max-per-stem", type=int, default=8)
    parser.add_argument("--max-stage", type=int, default=64)
    parser.add_argument("--sr", type=int, default=44100)
    parser.add_argument(
        "--output",
        default=None,
        help="Copy assembled mix to this path (after optional duration trim)",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Target mix length in seconds (scales bar counts, then trims/pads export)",
    )
    parser.add_argument(
        "--bpm",
        type=float,
        default=None,
        help="Target tempo applied to blueprint metadata (not prompt-only)",
    )
    parser.add_argument(
        "--key",
        default=None,
        help="Target key, e.g. Dmin / D minor / D (root + optional scale)",
    )
    parser.add_argument(
        "--normalize-lufs",
        type=float,
        default=None,
        help="Opt-in EBU R128 LUFS on --output only (unmastered mix stays ~-3 dBFS)",
    )
    parser.add_argument(
        "--ceiling-dbtp",
        type=float,
        default=-0.5,
        help="True-peak ceiling (dBTP, 4x oversampled) when --normalize-lufs is set",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help=(
            "Reproduce an exact conductor map. Omit it and the seed is derived from "
            "prompt + a fresh request id, so two users asking for the same genre "
            "get different songs."
        ),
    )
    parser.add_argument(
        "--request-id",
        default=None,
        help="User / session identity folded into the derived seed (default: random)",
    )
    parser.add_argument(
        "--no-arrange",
        action="store_true",
        help="Skip the local song conductor and use the legacy flat blueprint path",
    )
    parser.add_argument(
        "--vocal-mode",
        choices=("lead", "adlib", "none"),
        default=None,
        help=(
            "lead = lyrics expected (short ad-lib chops only on chorus/transition "
            "sections), adlib = no lyrics, none = instrumental (vocal bus muted)"
        ),
    )
    parser.add_argument(
        "--vocal-file",
        default=None,
        help="Ignored by the Lyria path. Kept so older CLI flags still parse.",
    )
    parser.add_argument("--style", default="", help="Style prompt sent to Lyria")
    parser.add_argument("--lyrics", default="", help="Lyrics appended after a blank line")
    args = parser.parse_args(argv)
    session_dir = session_scratch_dir(args.scratch, args.session)
    try:
        saved = render_lyria_master(
            session_dir,
            style=str(args.style or ""),
            prompt=str(args.prompt or ""),
            lyrics=str(args.lyrics or ""),
            session_id=str(args.session),
            duration_sec=args.duration,
        )
    except (ValueError, RuntimeError, OSError) as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 1
    print(f"[LYRIA] master={saved}", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
