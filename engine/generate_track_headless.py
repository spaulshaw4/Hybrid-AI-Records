"""Prompt → blueprint → capped session cache → unmastered mix (no GUI).

Default is offline heuristic. ``--live`` requires a Replicate token. If a token
is already in the environment and neither ``--offline`` nor ``--live`` was
passed, one live attempt is allowed and failures fall back offline.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
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
    INDEX_HONESTY,
    apply_arrangement_to_blueprint,
    conduct_arrangement,
    derive_seed,
    describe_conducted,
)
from engine.gemini_arranger import (  # noqa: E402
    DEFAULT_REPLICATE_MODEL,
    arrange_from_prompt,
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
DEFAULT_SCRATCH = r"D:\MusicDatasets\scratch"
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


def _keep_if_not_gutted(processed: Any, previous: Any, label: str) -> Any:
    """Reject an alignment stage that silenced or badly gutted the slice.

    Guard against a DSP stage returning near-silence from usable audio. A
    staged stem that is silent produces a silent bus, which is exactly the
    "vocal is not there" symptom this pipeline is meant to have fixed.
    """
    before = _rms_dbfs(previous)
    after = _rms_dbfs(processed)
    if before <= -119.0:
        return processed
    if after <= -119.0 or (before - after) > ALIGN_LOSS_TOLERANCE_DB:
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
            lock_slice_to_tempo(audio, target_bpm=float(target_bpm), sr=int(sr)),
            audio,
            f"tempo lock {os.path.basename(src_path)}",
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
    from engine.stem_selector import describe_selection, select_for_role

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

    if not db_path or not os.path.isfile(db_path):
        return 0
    try:
        conn = sqlite3.connect(db_path)
    except sqlite3.Error:
        return 0

    staged = 0
    staged_by: dict[str, int] = {role: 0 for role in STAGE_STEMS}
    try:
        for role in SELECTOR_ROLES:
            if staged >= max_stage:
                break
            # One spare beyond the variant pool so a drum fill has somewhere to go.
            want = min(int(max_per_stem), max(2, int(pool.get(role, 2)) + 1))
            picks = select_for_role(
                conn,
                role,
                target_key,
                target_bpm,
                want,
                rng,
                centroid_target_hz=centroid_targets.get(role),
                use_cooldown=not reproducible,
            )
            if not picks:
                print(f"[SELECT] {role}: no scored candidates in {os.path.basename(db_path)}")
                continue
            print(describe_selection(role, picks))
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
            if chosen_paths and not reproducible:
                try:
                    mark_slices_used(conn, chosen_paths)
                except Exception:
                    pass
    finally:
        conn.close()

    print(
        "[STAGE] scored per-stem "
        + " ".join(f"{role}={staged_by.get(role, 0)}" for role in SELECTOR_ROLES)
        + f" total={staged}"
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

    resolved_seed, resolved_request = derive_seed(prompt, request_id, seed)
    arrangement: dict[str, Any] | None = None
    if arrange:
        print(
            f"[CONDUCTOR] seed mode={'explicit (reproducible)' if seed is not None else 'derived'}"
        )
        print(f"[INDEX] {INDEX_HONESTY}")
        arrangement = conduct_arrangement(
            prompt,
            genre or meta.get("genre"),
            bpm_val,
            duration_sec,
            seed=resolved_seed,
            request_id=resolved_request,
        )
        blueprint = apply_arrangement_to_blueprint(blueprint, arrangement)
        # validate_blueprint rebuilds track_metadata from the contract fields,
        # which would drop CLI extras such as ``scale``. Carry them across.
        extra_meta = {
            key: value
            for key, value in (blueprint.get("track_metadata") or {}).items()
            if key not in {"title", "bpm", "root_key", "genre", "total_bars"}
        }
        blueprint = validate_blueprint(blueprint, enforce_section_span=False)
        blueprint["track_metadata"].update(extra_meta)
        print(f"[CONDUCTOR] request_id={resolved_request}")
        print(describe_conducted(arrangement))
    elif duration_sec is not None and duration_sec > 0:
        _fit_blueprint_duration(blueprint, float(duration_sec))
        blueprint = validate_blueprint(blueprint, enforce_section_span=True)

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
    staged = 0
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

    source_trace: dict[str, Any] = {}
    assemble_from_blueprint(
        blueprint_path,
        session_corpus,
        unmastered_named,
        sr=sr,
        seed=resolved_seed,
        target_key=None,
        target_bpm=None,
        index_db=None,
        use_index=False,
        source_trace=source_trace,
    )
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Headless prompt-to-unmastered mix")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--session", default="headless_session_01")
    parser.add_argument("--db", default=default_index_db())
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
    args = parser.parse_args(argv)
    corpus = args.corpus
    if not corpus:
        try:
            from engine.worker_handoff import resolve_worker_corpus

            corpus = resolve_worker_corpus()
        except Exception:
            corpus = DEFAULT_CORPUS
    print(f"[CORPUS] {corpus}", flush=True)
    try:
        result = execute_prompt_pipeline(
            args.prompt,
            args.session,
            args.db,
            args.scratch,
            genre=args.genre,
            offline=args.offline,
            live=args.live,
            corpus_dir=corpus,
            max_per_stem=args.max_per_stem,
            max_stage=args.max_stage,
            sr=args.sr,
            duration_sec=args.duration,
            output_path=args.output,
            bpm=args.bpm,
            key=args.key,
            normalize_lufs=args.normalize_lufs,
            ceiling_dbtp=args.ceiling_dbtp,
            seed=args.seed,
            request_id=args.request_id,
            arrange=not args.no_arrange,
        )
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 1
    print(
        f"[HEADLESS] mix={result['unmastered_mix']} output={result.get('output_wav')} "
        f"mode={result['mode']} staged={result['staged']} seed={result.get('seed')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
