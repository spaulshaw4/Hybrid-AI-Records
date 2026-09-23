"""Module 4 — Plan-conditioned arrangement assembly.

Iterates ``GlobalSongPlan.sections``, retrieves/adapts stems, and stitches
continuous multi-track buffers with equal-power section crossfades for
``RelationalMixer``.
"""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

import numpy as np
import soundfile as sf

from engine.stem_adapter import StemAdapter, section_sample_count
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

        # Per-bus list of section buffers (pre-xfade).
        section_buffers: dict[str, list[np.ndarray]] = {bus: [] for bus in ASSEMBLY_BUSES}
        trace: dict[str, Any] = {
            "sections": [],
            "xfade_ms": self.xfade_ms,
            "sr": self.sr,
            "time_signature": plan.time_signature,
            "beats_per_bar": bpb,
        }

        last_idx = len(plan.sections) - 1
        grid_start = 0
        for idx, section in enumerate(plan.sections):
            n = section_sample_count(int(section.bars), bpm, self.sr, beats_per_bar=bpb)
            # The seam crossfade consumes this tail, so every section onset
            # stays on the bar grid (sum of preceding section lengths).
            extra = fade if idx < last_idx else 0
            families = self._families_for_section(section)
            chosen: dict[str, Any] = {}
            # Accumulate into bus buckets (multiple families may share harmonic).
            bus_acc: dict[str, np.ndarray] = {
                bus: np.zeros((n + extra, self.channels), dtype=np.float64)
                for bus in ASSEMBLY_BUSES
            }
            for family in families:
                query = StemCandidateQuery(
                    instrument_family=family,
                    target_bpm=int(round(bpm)),
                    target_key=key,
                    target_chord=(section.chord_progression[0] if section.chord_progression else key),
                    energy_tier=float(section.energy_level),
                    genre_vector=genre,
                    scale=str(plan.scale),
                    time_signature=str(plan.time_signature),
                )
                audio, meta = self._retrieve_or_synthesize(query, section, n + extra)
                adapted, info = adapter.adapt(
                    audio,
                    bars=int(section.bars),
                    target_bpm=bpm,
                    target_key=key,
                    source_bpm=meta.get("estimated_bpm"),
                    source_key=meta.get("detected_key"),
                    pitch_shift_semitones=meta.get("pitch_shift_semitones"),
                    metadata=meta,
                    extra_samples=extra,
                )
                bus = query.bus()
                bus_acc[bus] += _ensure_2d(adapted, self.channels)[: n + extra]
                chosen[family] = {
                    "file_path": meta.get("file_path"),
                    "bus": bus,
                    "synthetic": bool(meta.get("synthetic")),
                    "silenced": bool(meta.get("silenced")),
                    "synthetic_reason": meta.get("synthetic_reason"),
                    **info,
                }
                if meta.get("synthetic") or meta.get("silenced"):
                    trace.setdefault("non_corpus_stems", []).append(
                        {
                            "section": section.name,
                            "family": family,
                            "synthetic": bool(meta.get("synthetic")),
                            "reason": meta.get("synthetic_reason"),
                        }
                    )
            for bus in ASSEMBLY_BUSES:
                section_buffers[bus].append(bus_acc[bus])
            trace["sections"].append(
                {
                    "name": section.name,
                    "bars": section.bars,
                    "samples": n,
                    "start_sample": grid_start,
                    "stems": chosen,
                }
            )
            grid_start += n

        tracks: dict[str, np.ndarray] = {}
        for bus in ASSEMBLY_BUSES:
            tracks[bus] = self._stitch(section_buffers[bus], fade)

        # Align all buses to the longest track length.
        max_len = max((t.shape[0] for t in tracks.values()), default=0)
        for bus in ASSEMBLY_BUSES:
            arr = tracks[bus]
            if arr.shape[0] < max_len:
                pad = ((0, max_len - arr.shape[0]),) + ((0, 0),) * (arr.ndim - 1)
                tracks[bus] = np.pad(arr, pad)
            elif arr.shape[0] > max_len:
                tracks[bus] = arr[:max_len]

        mix = _sum_tracks(tracks)
        return AssemblyResult(tracks=tracks, mix=mix, trace=trace)

    def _families_for_section(self, section: SectionPlan) -> list[str]:
        families: list[str] = []
        for stem in section.active_stems:
            key = str(stem).strip().lower()
            family = STEM_TO_FAMILY.get(key)
            if family and family not in families:
                families.append(family)
        if not families:
            families = ["drums", "bass", "rhythm_guitar"]
        return families

    def _retrieve_or_synthesize(
        self,
        query: StemCandidateQuery,
        section: SectionPlan,
        n: int,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        family = query.instrument_family
        load_error: str
        if self._retriever is None or self._retriever.conn is None:
            load_error = "no_index: corpus index unavailable"
        else:
            try:
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
