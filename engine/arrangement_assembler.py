"""Module 4 — Plan-conditioned arrangement assembly.

Iterates ``GlobalSongPlan.sections``, retrieves/adapts stems, and stitches
continuous multi-track buffers with equal-power section crossfades for
``RelationalMixer``.
"""
from __future__ import annotations

import os
import sqlite3
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

import numpy as np
import soundfile as sf

from engine.conductor_matrix import apply_bar_dsp, blend_bar_into
from engine.genre_planner import (
    dsp_rules_from_section,
    get_arrangement_blueprint,
    rules_for_bar,
)
from engine.hybrid_conductor import AdaptiveConductor
from engine.stem_adapter import StemAdapter, section_sample_count, tile_loop_on_grid
from engine.stem_retriever import (
    SQLiteStemRetriever,
    StemCandidateQuery,
)
from engine.song_plan import (
    GenreVector,
    GlobalSongPlan,
    SectionPlan,
    beats_per_bar,
    song_plan_from_dict,
)
from engine.stem_selector import extract_session_slug, pack_id_from_path

# One pull: drums (anchor) + bass + rhythm guitar. Optional vocal/lead once.
BAND_FAMILIES = ("drums", "bass", "rhythm_guitar")

# Core mixer buses (Module 2).
ARRANGE_BUSES = ("rhythm", "bass", "harmonic", "vocal")
# Assembly also renders a dedicated melodic-lead bus (lead guitar / synth
# lead) so the relational mid-carve can key on it.
ASSEMBLY_BUSES = ARRANGE_BUSES + ("lead",)

# Section active_stems names → instrument family for retrieval.
STEM_TO_FAMILY: dict[str, str] = {
    "drums": "drums",
    "drum": "drums",
    "rhythm": "drums",
    "percussion": "drums",
    "bass": "bass",
    "808": "bass",
    "sub": "bass",
    "rhythm_guitar": "rhythm_guitar",
    "guitar": "rhythm_guitar",
    "lead_guitar": "lead_guitar",
    "lead": "lead_guitar",
    "solo": "lead_guitar",
    "synth": "synth",
    "synth_lead": "synth_lead",
    "pads": "synth",
    "pad": "synth",
    "keys": "synth",
    "fx": "synth",
    "vocal": "vocal",
    "vocals": "vocal",
    "lead_vocal": "vocal",
    "vox": "vocal",
}

DEFAULT_XFADE_MS = 18.0  # inside the 10–25 ms brief window
# Families a production render cannot ship without (require_corpus=True).
CRITICAL_FAMILIES = frozenset({"drums", "bass", "rhythm_guitar"})
SynthFn = Callable[[str, SectionPlan, int, int], np.ndarray]


@dataclass
class AssemblyResult:
    tracks: dict[str, np.ndarray]
    mix: np.ndarray
    trace: dict[str, Any] = field(default_factory=dict)

    def as_mixer_stems(self) -> dict[str, np.ndarray]:
        return {bus: self.tracks[bus] for bus in ASSEMBLY_BUSES if bus in self.tracks}


def _as_plan(song_plan: GlobalSongPlan | Mapping[str, Any]) -> GlobalSongPlan:
    if isinstance(song_plan, GlobalSongPlan):
        return song_plan
    return song_plan_from_dict(dict(song_plan))


def _genre_vector(plan: GlobalSongPlan) -> GenreVector:
    return plan.genre_blend


def _equal_power_xfade(a: np.ndarray, b: np.ndarray, fade: int) -> np.ndarray:
    from dsp.micro_crossfader import apply_equal_power_crossfade

    return apply_equal_power_crossfade(a, b, int(fade))


def _ensure_2d(audio: np.ndarray, channels: int = 1) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, np.newaxis]
    if data.shape[1] < channels:
        data = np.repeat(data, channels, axis=1)[:, :channels]
    elif data.shape[1] > channels:
        data = data[:, :channels]
    return data


def _sum_tracks(tracks: Mapping[str, np.ndarray]) -> np.ndarray:
    acc: np.ndarray | None = None
    channels = max(
        (np.asarray(a).shape[1] for a in tracks.values() if np.asarray(a).ndim == 2),
        default=1,
    )
    for bus in ASSEMBLY_BUSES:
        audio = tracks.get(bus)
        if audio is None or np.asarray(audio).size == 0:
            continue
        frames = _ensure_2d(audio, channels)
        if acc is None:
            acc = np.zeros_like(frames)
        n = min(acc.shape[0], frames.shape[0])
        ch = min(acc.shape[1], frames.shape[1])
        acc[:n, :ch] += frames[:n, :ch]
    if acc is None:
        return np.zeros(0, dtype=np.float64)
    return acc[:, 0] if acc.shape[1] == 1 else acc


def _synthetic_stem(family: str, section: SectionPlan, n: int, sr: int) -> np.ndarray:
    """Offline fallback when the corpus has no match (tests / dry runs)."""
    t = np.arange(n, dtype=np.float64) / float(sr)
    energy = float(section.energy_level)
    amp = 0.12 + 0.18 * energy
    if family == "drums":
        # Continuous low bed + quarter clicks (no silent gaps for xfade tests).
        out = 0.08 * amp * np.sin(2 * np.pi * 60.0 * t)
        step = max(1, n // max(1, section.bars * 4))
        for i in range(0, n, step):
            end = min(n, i + max(8, sr // 400))
            out[i:end] += amp * np.linspace(1.0, 0.0, end - i)
        return out
    if family == "bass":
        return amp * np.sin(2 * np.pi * 55.0 * t)
    if family == "vocal":
        return amp * 0.7 * np.sin(2 * np.pi * 220.0 * t)
    # harmonic / guitar / synth
    return amp * (
        0.6 * np.sin(2 * np.pi * 164.81 * t) + 0.4 * np.sin(2 * np.pi * 246.94 * t)
    )


class ArrangementAssembler:
    """Retrieve → adapt → stitch section stems into mixer-ready multi-tracks."""

    def __init__(
        self,
        *,
        sr: int = 44100,
        index_db: str | None = None,
        conn: sqlite3.Connection | None = None,
        retriever: SQLiteStemRetriever | None = None,
        adapter: StemAdapter | None = None,
        xfade_ms: float = DEFAULT_XFADE_MS,
        synthesize_fn: SynthFn | None = None,
        load_audio: Callable[[str], np.ndarray] | None = None,
        seed: int = 0,
        channels: int = 2,
        require_corpus: bool = False,
    ) -> None:
        """``require_corpus=True`` (production): a critical family that cannot be
        retrieved or loaded raises ``RuntimeError``; optional families are left
        silent and flagged. ``False`` (tests / dry runs) substitutes flagged
        synthetic tones.
        """
        self.sr = int(sr)
        self.channels = max(1, int(channels))
        self.require_corpus = bool(require_corpus)
        self._custom_adapter = adapter is not None
        self.adapter = adapter or StemAdapter(self.sr)
        self.xfade_ms = float(np.clip(xfade_ms, 10.0, 25.0))
        self.synthesize_fn = synthesize_fn
        self.load_audio = load_audio or self._default_load
        self.seed = int(seed)
        self._motif_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._anchor_slug = ""
        self._retriever = retriever
        self._owned_retriever = False
        if self._retriever is None:
            self._retriever = SQLiteStemRetriever(
                conn=conn,
                index_db=index_db,
                require_on_disk=load_audio is None,
            )
            self._owned_retriever = True

    @staticmethod
    def _default_load(path: str) -> np.ndarray:
        data, _sr = sf.read(path, always_2d=False)
        return np.asarray(data, dtype=np.float64)

    def close(self) -> None:
        if self._owned_retriever and self._retriever is not None:
            self._retriever.close()

    def build_arrangement(
        self,
        song_plan: GlobalSongPlan | Mapping[str, Any],
    ) -> dict[str, np.ndarray]:
        """Assemble continuous multi-track buffers ready for ``RelationalMixer``."""
        return self.assemble(song_plan).tracks

    def assemble(
        self,
        song_plan: GlobalSongPlan | Mapping[str, Any],
    ) -> AssemblyResult:
        plan = _as_plan(song_plan)
        bpm = float(plan.bpm)
        key = str(plan.key)
        genre = _genre_vector(plan)
        fade = max(1, int(round(self.sr * self.xfade_ms / 1000.0)))
        bpb = beats_per_bar(plan.time_signature)
        adapter = (
            self.adapter
            if self._custom_adapter
            else StemAdapter(self.sr, beats_per_bar=bpb)
        )
        total_bars = max(
            1,
            int(plan.total_bars or 0) or sum(int(s.bars) for s in plan.sections) or 1,
        )
        total_n = section_sample_count(total_bars, bpm, self.sr, beats_per_bar=bpb)
        zc = max(1, int(round(self.sr * 0.015)))

        trace: dict[str, Any] = {
            "sections": [],
            "xfade_ms": self.xfade_ms,
            "sr": self.sr,
            "time_signature": plan.time_signature,
            "beats_per_bar": bpb,
            "band_lock": True,
        }
        compose_t0 = time.perf_counter()
        print(
            f"[COMPOSITION] Arranging section band_lock with anchor "
            f"{self._anchor_slug or '-'}...",
            flush=True,
        )
        try:
            band_meta, dry = self._lock_band(
                plan, adapter, genre, bpm, key, total_n, fade, zc, trace
            )
            genre_name = ""
            if isinstance(plan.core_metadata, dict):
                genre_name = str(
                    plan.core_metadata.get("genre") or plan.core_metadata.get("genre_hint") or ""
                )
            if not genre_name and plan.source_genres:
                first = plan.source_genres[0]
                if isinstance(first, dict):
                    genre_name = str(first.get("genre") or first.get("slug") or "")
            # Executive planner owns arrangement. Picker already locked the band.
            blueprint = get_arrangement_blueprint(genre_name or None, total_bars)
            conductor = AdaptiveConductor(total_bars, genre_name)
            tension = conductor.generate_tension_map()
            tracks: dict[str, np.ndarray] = {
                bus: np.zeros((total_n, self.channels), dtype=np.float64)
                for bus in ASSEMBLY_BUSES
            }
            last_rules: dict[str, Any] | None = None
            for bar in range(total_bars):
                start = 0 if bar == 0 else section_sample_count(
                    bar, bpm, self.sr, beats_per_bar=bpb
                )
                end = min(
                    total_n,
                    section_sample_count(bar + 1, bpm, self.sr, beats_per_bar=bpb),
                )
                if end <= start:
                    continue
                energy = float(tension[bar])
                planned = rules_for_bar(blueprint, bar)
                rules = dsp_rules_from_section(planned)
                rules["tension"] = energy
                if rules != last_rules:
                    print(
                        f"[COMPOSITION] Arranging section {rules.get('role', bar)} "
                        f"with anchor {self._anchor_slug or '-'}... "
                        f"kick_muted={rules['kick_muted']} "
                        f"filter={rules['rhythm_filter'] or '-'} "
                        f"width={rules.get('stereo_width')}",
                        flush=True,
                    )
                    last_rules = dict(rules)
                sliced = {
                    bus: np.asarray(audio)[start:end]
                    for bus, audio in dry.items()
                    if np.asarray(audio).size
                }
                processed = apply_bar_dsp(
                    sliced, rules, self.sr, bpm, beats_per_bar=bpb
                )
                blend_bar_into(tracks, processed, start, end, sr=self.sr)

            grid_start = 0
            for section in plan.sections:
                n = section_sample_count(
                    int(section.bars), bpm, self.sr, beats_per_bar=bpb
                )
                chosen = {
                    family: {
                        **dict(meta),
                        "band_lock": True,
                        "motif_reuse": True,
                    }
                    for family, meta in band_meta.items()
                }
                if plan.sections and section is plan.sections[0]:
                    for item in chosen.values():
                        item["motif_reuse"] = False
                trace["sections"].append(
                    {
                        "name": section.name,
                        "bars": section.bars,
                        "samples": n,
                        "start_sample": grid_start,
                        "stems": chosen,
                        "energy_arc": [
                            float(tension[i])
                            for i in range(
                                int(section.start_bar),
                                min(total_bars, int(section.start_bar) + int(section.bars)),
                            )
                        ],
                    }
                )
                grid_start += n
        except Exception:
            print(
                f"[COMPOSITION] failed after {time.perf_counter() - compose_t0:.2f}s\n"
                f"{traceback.format_exc()}",
                flush=True,
            )
            raise

        print(
            f"[COMPOSITION] elapsed_sec={time.perf_counter() - compose_t0:.2f} "
            f"bars={total_bars} anchor={self._anchor_slug or '-'}",
            flush=True,
        )
        mix = _sum_tracks(tracks)
        trace["anchor_slug"] = self._anchor_slug
        trace["motifs"] = {
            family: {
                "file_path": meta.get("file_path"),
                "affinity_source": meta.get("affinity_source"),
            }
            for family, meta in band_meta.items()
        }
        trace["energy_arc"] = [float(x) for x in tension]
        trace["tension_map"] = trace["energy_arc"]
        trace["arrangement_blueprint"] = {
            "family": blueprint.get("family"),
            "style": blueprint.get("style"),
            "authority": "genre_planner",
            "sections": [
                {
                    "name": s.get("name"),
                    "start_bar": s.get("start_bar"),
                    "bars": s.get("bars"),
                    "kick_muted": s.get("kick_muted"),
                    "breakdown": s.get("breakdown"),
                    "stereo_width": s.get("stereo_width"),
                }
                for s in blueprint.get("sections") or []
            ],
        }
        return AssemblyResult(tracks=tracks, mix=mix, trace=trace)

    def _lock_band(
        self,
        plan: GlobalSongPlan,
        adapter: StemAdapter,
        genre: GenreVector,
        bpm: float,
        key: str,
        total_n: int,
        fade: int,
        zc: int,
        trace: dict[str, Any],
    ) -> tuple[dict[str, dict[str, Any]], dict[str, np.ndarray]]:
        """One corpus pull for the band. Later bars reuse these buffers."""
        lock_section = plan.sections[0] if plan.sections else SectionPlan(
            name="lock",
            start_bar=0,
            bars=4,
            energy_level=0.5,
            chord_progression=[key],
            active_stems=["drums", "bass", "rhythm_guitar"],
            frequency_reservations={},
        )
        wanted = set(BAND_FAMILIES)
        for section in plan.sections:
            for family in self._families_for_section(section):
                if family in {"vocal", "lead_guitar", "synth_lead"}:
                    wanted.add(family)
        families = [name for name in BAND_FAMILIES if name in wanted]
        families.extend(sorted(wanted - set(BAND_FAMILIES)))

        loop_bars = 4
        loop_n = section_sample_count(
            loop_bars, bpm, self.sr, beats_per_bar=beats_per_bar(plan.time_signature)
        )
        band_meta: dict[str, dict[str, Any]] = {}
        dry: dict[str, np.ndarray] = {
            bus: np.zeros((total_n, self.channels), dtype=np.float64)
            for bus in ASSEMBLY_BUSES
        }
        for family in families:
            query = StemCandidateQuery(
                instrument_family=family,
                target_bpm=int(round(bpm)),
                target_key=key,
                target_chord=(
                    lock_section.chord_progression[0]
                    if lock_section.chord_progression
                    else key
                ),
                energy_tier=float(lock_section.energy_level),
                genre_vector=genre,
                scale=str(plan.scale),
                time_signature=str(plan.time_signature),
            )
            audio, meta = self._retrieve_or_synthesize(
                query,
                lock_section,
                loop_n,
                anchor_slug=self._anchor_slug or None,
            )
            if family == "drums" and meta.get("file_path") and not self._anchor_slug:
                self._anchor_slug = pack_id_from_path(str(meta["file_path"])) or extract_session_slug(
                    str(meta["file_path"])
                )
                print(f"[AFFINITY] drum_anchor_slug={self._anchor_slug or '-'}", flush=True)
            adapted, info = adapter.adapt(
                audio,
                bars=loop_bars,
                target_bpm=bpm,
                target_key=key,
                source_bpm=meta.get("estimated_bpm"),
                source_key=meta.get("detected_key"),
                pitch_shift_semitones=meta.get("pitch_shift_semitones"),
                metadata=meta,
            )
            looped = tile_loop_on_grid(
                _ensure_2d(adapted, self.channels),
                total_n,
                period=max(1, loop_n),
                fade=fade,
                zc_radius=zc,
            )
            bus = query.bus()
            dry[bus] = _ensure_2d(looped, self.channels)[:total_n]
            chosen = {
                "file_path": meta.get("file_path"),
                "bus": bus,
                "synthetic": bool(meta.get("synthetic")),
                "silenced": bool(meta.get("silenced")),
                "synthetic_reason": meta.get("synthetic_reason"),
                "motif_reuse": False,
                "affinity_source": meta.get("affinity_source"),
                "band_lock": True,
                **info,
            }
            band_meta[family] = chosen
            if meta.get("synthetic") or meta.get("silenced"):
                trace.setdefault("non_corpus_stems", []).append(
                    {
                        "section": "band_lock",
                        "family": family,
                        "synthetic": bool(meta.get("synthetic")),
                        "reason": meta.get("synthetic_reason"),
                    }
                )
        return band_meta, dry

    def _families_for_section(self, section: SectionPlan) -> list[str]:
        families: list[str] = []
        for stem in section.active_stems:
            key = str(stem).strip().lower()
            family = STEM_TO_FAMILY.get(key)
            if family and family not in families:
                families.append(family)
        if not families:
            families = ["drums", "bass", "rhythm_guitar"]
        if "drums" in families:
            families = ["drums"] + [item for item in families if item != "drums"]
        return families

    def _retrieve_or_synthesize(
        self,
        query: StemCandidateQuery,
        section: SectionPlan,
        n: int,
        *,
        cached: dict[str, Any] | None = None,
        anchor_slug: str | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        family = query.instrument_family
        if cached and cached.get("file_path") and self.load_audio is not None:
            try:
                audio = self.load_audio(str(cached["file_path"]))
                reused = dict(cached)
                reused["motif_reuse"] = True
                return np.asarray(audio, dtype=np.float64), reused
            except Exception:
                pass
        load_error: str
        if self._retriever is None or self._retriever.conn is None:
            load_error = "no_index: corpus index unavailable"
        else:
            try:
                try:
                    candidate = self._retriever.best_candidate(
                        query, anchor_slug=anchor_slug if family != "drums" else None
                    )
                except TypeError:
                    candidate = self._retriever.best_candidate(query)
            except Exception as exc:
                candidate = None
                load_error = f"query_failed: {type(exc).__name__}: {exc}"
            else:
                load_error = (
                    "no_candidate: nothing within BPM/key/energy tolerance "
                    f"(bpm={query.target_bpm} key={query.target_key} "
                    f"energy={query.energy_tier:.2f})"
                )
            if candidate and candidate.get("file_path"):
                path = str(candidate["file_path"])
                try:
                    audio = self.load_audio(path)
                    return np.asarray(audio, dtype=np.float64), dict(candidate)
                except Exception as exc:
                    load_error = f"load_failed: {path}: {type(exc).__name__}: {exc}"

        base_meta: dict[str, Any] = {
            "file_path": None,
            "estimated_bpm": float(query.target_bpm),
            "detected_key": query.target_key,
            "pitch_shift_semitones": 0,
            "instrument_family": family,
            "synthetic_reason": load_error,
        }
        if self.require_corpus:
            if family in CRITICAL_FAMILIES:
                raise RuntimeError(
                    f"[ASSEMBLE] critical stem '{family}' unavailable for section "
                    f"'{section.name}': {load_error}"
                )
            print(
                f"[ASSEMBLE] optional stem '{family}' silenced in '{section.name}': "
                f"{load_error}",
                flush=True,
            )
            return np.zeros((n, self.channels), dtype=np.float64), {
                **base_meta,
                "synthetic": False,
                "silenced": True,
            }

        print(
            f"[ASSEMBLE] synthetic '{family}' in '{section.name}': {load_error}",
            flush=True,
        )
        if self.synthesize_fn is not None:
            audio = self.synthesize_fn(family, section, n, self.sr)
        else:
            audio = _synthetic_stem(family, section, n, self.sr)
        return np.asarray(audio, dtype=np.float64), {**base_meta, "synthetic": True}

    def _stitch(self, parts: Sequence[np.ndarray], fade: int) -> np.ndarray:
        if not parts:
            return np.zeros(0, dtype=np.float64)
        current = np.asarray(parts[0], dtype=np.float64)
        for nxt in parts[1:]:
            nxt_arr = np.asarray(nxt, dtype=np.float64)
            if current.size == 0:
                current = nxt_arr
                continue
            if nxt_arr.size == 0:
                continue
            # Each non-final part carries ``fade`` samples past its barline;
            # the overlap consumes exactly that tail, so onsets stay on grid.
            use_fade = min(int(fade), current.shape[0], nxt_arr.shape[0])
            current = _equal_power_xfade(current, nxt_arr, use_fade)
        return current
