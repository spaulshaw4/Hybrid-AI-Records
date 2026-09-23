"""Module 3 — Regeneration Gatekeeper.

Runs ``SongEvaluator`` on mixed stems + master. When quality fails, retries
only the offending stem/section bars (up to 2 attempts) while preserving
validated regions.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, MutableMapping, Sequence

import numpy as np

from engine.song_evaluator import (
    COMPOSITE_PASS,
    QualityScore,
    SongEvaluator,
    _section_from_mapping,
)
from engine.song_plan import SectionPlan, beats_per_bar
from engine.stem_adapter import section_sample_count

# regenerate_fn(stem_name, section, start_sample, end_sample, attempt) -> audio
RegenerateFn = Callable[[str, SectionPlan, int, int, int], np.ndarray]

ARRANGE_BUSES = ("rhythm", "bass", "harmonic", "vocal")
# Buses summed into the gate's mix (includes the optional melodic-lead bus).
MIX_BUSES = ARRANGE_BUSES + ("lead",)
MAX_RETRIES = 2


@dataclass
class GateResult:
    score: QualityScore
    stems: dict[str, np.ndarray]
    mix: np.ndarray
    retries: list[dict[str, Any]] = field(default_factory=list)
    preserved_sections: list[str] = field(default_factory=list)
    regenerated_sections: list[str] = field(default_factory=list)
    report_path: str | None = None

    def to_report(self) -> dict[str, Any]:
        return {
            "passed": self.score.passed,
            "composite": self.score.composite,
            "harmonic_coherence": self.score.harmonic_coherence,
            "spectral_balance": self.score.spectral_balance,
            "integrated_lufs": self.score.integrated_lufs,
            "true_peak_dbtp": self.score.true_peak_dbtp,
            "failing_stems": list(self.score.failing_stems),
            "failing_sections": list(self.score.failing_sections),
            "preserved_sections": list(self.preserved_sections),
            "regenerated_sections": list(self.regenerated_sections),
            "retries": list(self.retries),
            "details": dict(self.score.details),
        }


def _section_span(
    section: SectionPlan,
    sr: int,
    bpm: float,
    beats_per_bar: float = 4.0,
) -> tuple[int, int]:
    """Bar-math span; matches ``ArrangementAssembler``'s grid-locked onsets."""
    start = section_sample_count(int(section.start_bar), bpm, sr, beats_per_bar=beats_per_bar)
    if int(section.start_bar) == 0:
        start = 0
    length = section_sample_count(int(section.bars), bpm, sr, beats_per_bar=beats_per_bar)
    return start, start + length


def _sum_stems(stems: Mapping[str, np.ndarray]) -> np.ndarray:
    acc: np.ndarray | None = None
    for bus in MIX_BUSES:
        audio = stems.get(bus)
        if audio is None:
            continue
        arr = np.asarray(audio, dtype=np.float64)
        if arr.ndim == 1:
            arr = arr[:, np.newaxis]
        if acc is None:
            acc = np.zeros_like(arr)
        n = min(acc.shape[0], arr.shape[0])
        ch = min(acc.shape[1], arr.shape[1])
        acc[:n, :ch] += arr[:n, :ch]
    if acc is None:
        return np.zeros(0, dtype=np.float64)
    if acc.shape[1] == 1:
        return acc[:, 0]
    return acc


SPLICE_FADE_MAX = 256


def _replace_region(
    dest: np.ndarray,
    replacement: np.ndarray,
    start: int,
    end: int,
) -> np.ndarray:
    """Splice ``replacement`` into ``dest[start:end]`` (padded/trimmed to fit).

    Both seams use equal-power cos/sin ramps of ``min(256, length // 4)``
    samples inside the region: original → replacement at ``start`` and
    replacement → original at ``end``. Audio outside ``[start, end)`` is
    untouched.
    """
    out = np.asarray(dest, dtype=np.float64).copy()
    was_1d = out.ndim == 1
    if was_1d:
        out = out[:, np.newaxis]
    rep = np.asarray(replacement, dtype=np.float64)
    if rep.ndim == 1:
        rep = rep[:, np.newaxis]
    length = max(0, end - start)
    if length <= 0 or start >= out.shape[0]:
        return dest if was_1d else out
    end = min(out.shape[0], start + length)
    length = end - start
    if rep.shape[0] < length:
        pad = np.zeros((length - rep.shape[0], rep.shape[1]), dtype=np.float64)
        rep = np.concatenate([rep, pad], axis=0)
    else:
        rep = rep[:length]
    if rep.shape[1] < out.shape[1]:
        rep = np.pad(rep, ((0, 0), (0, out.shape[1] - rep.shape[1])))
    elif rep.shape[1] > out.shape[1]:
        rep = rep[:, : out.shape[1]]
    fade = min(SPLICE_FADE_MAX, length // 4)
    if fade > 0:
        theta = np.linspace(0.0, 0.5 * np.pi, fade, dtype=np.float64)[:, np.newaxis]
        fade_in = np.sin(theta)
        fade_out = np.cos(theta)
        rep = rep.copy()
        rep[:fade] = out[start : start + fade] * fade_out + rep[:fade] * fade_in
        rep[-fade:] = rep[-fade:] * fade_out + out[end - fade : end] * fade_in
    out[start:end] = rep
    return out[:, 0] if was_1d else out


class RegenerationGatekeeper:
    """Evaluate → localized retry → re-evaluate (max 2 stem/section retries)."""

    def __init__(
        self,
        *,
        evaluator: SongEvaluator | None = None,
        max_retries: int = MAX_RETRIES,
        min_composite: float = COMPOSITE_PASS,
    ) -> None:
        self.evaluator = evaluator or SongEvaluator(composite_pass=min_composite)
        self.max_retries = int(max_retries)
        self.min_composite = float(min_composite)

    def run(
        self,
        stems: Mapping[str, np.ndarray],
        mix: np.ndarray | None,
        sr: int,
        *,
        song_plan: Mapping[str, Any] | None = None,
        regenerate_fn: RegenerateFn | None = None,
        report_dir: str | None = None,
        report_name: str = "quality_report.json",
    ) -> GateResult:
        plan = dict(song_plan or {})
        bpm = float(plan.get("bpm") or 120.0)
        bpb = beats_per_bar(plan.get("time_signature"))
        sections = [
            s
            for s in (_section_from_mapping(item) for item in (plan.get("sections") or []))
            if s is not None
        ]

        working: MutableMapping[str, np.ndarray] = {
            k: np.asarray(v, dtype=np.float64) for k, v in stems.items() if v is not None
        }
        current_mix = (
            np.asarray(mix, dtype=np.float64) if mix is not None else _sum_stems(working)
        )

        score = self.evaluator.evaluate(
            current_mix,
            int(sr),
            stems=working,
            sections=sections,
            song_plan=plan,
        )
        retries: list[dict[str, Any]] = []
        regenerated: list[str] = []
        all_names = [s.name for s in sections]
        preserved = [n for n in all_names if n not in score.failing_sections]

        needs_work = (
            (not score.passed)
            or score.composite < self.min_composite
            or bool(score.failing_sections)
        )
        if not needs_work:
            result = GateResult(
                score=score,
                stems=dict(working),
                mix=current_mix,
                retries=retries,
                preserved_sections=preserved,
                regenerated_sections=regenerated,
            )
            result.report_path = self._write_report(result, report_dir, report_name)
            return result

        if regenerate_fn is None or not sections:
            # No regenerator — still emit the failing report.
            result = GateResult(
                score=score,
                stems=dict(working),
                mix=current_mix,
                retries=retries,
                preserved_sections=preserved,
                regenerated_sections=regenerated,
            )
            result.report_path = self._write_report(result, report_dir, report_name)
            return result

        # Localized retries: only failing stems × failing sections.
        targets = self._regen_targets(score, sections, working)
        for attempt in range(1, self.max_retries + 1):
            if not targets:
                break
            for stem_name, section in targets:
                start, end = _section_span(section, int(sr), bpm, bpb)
                end = min(end, current_mix.shape[0] if current_mix.size else end)
                if start >= end:
                    continue
                try:
                    replacement = regenerate_fn(stem_name, section, start, end, attempt)
                except Exception as exc:
                    retries.append(
                        {
                            "attempt": attempt,
                            "stem": stem_name,
                            "section": section.name,
                            "bars": [section.start_bar, section.start_bar + section.bars],
                            "error": str(exc),
                        }
                    )
                    continue
                if stem_name in working:
                    working[stem_name] = _replace_region(
                        working[stem_name], replacement, start, end
                    )
                else:
                    # Inject a sparse stem covering the full mix length.
                    base = np.zeros_like(current_mix) if current_mix.ndim == 1 else np.zeros(
                        (current_mix.shape[0], 1)
                    )
                    working[stem_name] = _replace_region(base, replacement, start, end)
                regenerated.append(section.name)
                retries.append(
                    {
                        "attempt": attempt,
                        "stem": stem_name,
                        "section": section.name,
                        "bars": [section.start_bar, section.start_bar + section.bars],
                        "start_sample": start,
                        "end_sample": end,
                    }
                )
            # Rebuild mix from stems so validated regions stay intact.
            current_mix = _sum_stems(working)
            score = self.evaluator.evaluate(
                current_mix,
                int(sr),
                stems=working,
                sections=sections,
                song_plan=plan,
            )
            preserved = [n for n in all_names if n not in score.failing_sections]
            if (
                score.passed
                and score.composite >= self.min_composite
                and not score.failing_sections
            ):
                break
            targets = self._regen_targets(score, sections, working)

        result = GateResult(
            score=score,
            stems=dict(working),
            mix=current_mix,
            retries=retries,
            preserved_sections=list(dict.fromkeys(preserved)),
            regenerated_sections=list(dict.fromkeys(regenerated)),
        )
        result.report_path = self._write_report(result, report_dir, report_name)
        return result

    def _regen_targets(
        self,
        score: QualityScore,
        sections: Sequence[SectionPlan],
        stems: Mapping[str, np.ndarray],
    ) -> list[tuple[str, SectionPlan]]:
        # Retries are localized: without a failing section there is nothing to
        # splice, and a whole-track re-render is never triggered from here.
        fail_sections = set(score.failing_sections)
        if not fail_sections:
            return []
        fail_stems = list(score.failing_stems) or [
            b for b in MIX_BUSES if b in stems
        ]
        targets: list[tuple[str, SectionPlan]] = []
        for section in sections:
            if section.name not in fail_sections:
                continue
            for stem in fail_stems:
                targets.append((stem, section))
        return targets

    @staticmethod
    def _write_report(
        result: GateResult,
        report_dir: str | None,
        report_name: str,
    ) -> str | None:
        if not report_dir:
            return None
        os.makedirs(report_dir, exist_ok=True)
        path = os.path.join(report_dir, report_name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(result.to_report(), fh, indent=2)
        print(
            f"[QUALITY] passed={result.score.passed} composite={result.score.composite:.3f} "
            f"LUFS={result.score.integrated_lufs:.2f} dBTP={result.score.true_peak_dbtp:.2f} "
            f"-> {path}"
        )
        return path
