"""Module 3 — Automated Song-Quality Evaluator.

Inspects harmonic consistency vs ``SectionPlan`` chords, spectral balance
(mud / harshness bands), and loudness compliance (integrated LUFS + true peak)
before delivery.
"""
from __future__ import annotations

import re
from typing import Any, List, Mapping, Sequence

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from engine.dsp_utils import bandpass, rms_dbfs, to_mono
from engine.song_plan import NOTE_NAMES, SectionPlan, _FLAT_TO_SHARP, beats_per_bar

# Melodic / tonal buses used for chromagram correlation.
MELODIC_BUSES = ("harmonic", "vocal", "bass", "lead")
# Spectral mud / harsh windows from the Module 3 brief.
MUD_BAND_HZ = (200.0, 500.0)
HARSH_BAND_HZ = (3500.0, 6000.0)
DEFAULT_LUFS_TARGET = -14.0
DEFAULT_TRUE_PEAK_LIMIT = -1.0
# Soft tolerance around the LUFS target (production masters rarely land exact).
LUFS_TOLERANCE_LU = 2.5
COMPOSITE_PASS = 0.45
# Thresholds on the chance-scaled in-template energy score
# (0 = no better than a flat chroma, 1 = all energy on template notes).
HARMONIC_PASS = 0.25
STEM_HARMONIC_FLAG = 0.10

_CHORD_RE = re.compile(r"^([A-Ga-g](?:#|b)?)(.*)$")


class QualityScore(BaseModel):
    """Gatekeeper scorecard for one mix (or one section slice)."""

    model_config = ConfigDict(extra="forbid")

    harmonic_coherence: float = Field(..., ge=0.0, le=1.0)
    spectral_balance: float = Field(..., ge=0.0, le=1.0)
    integrated_lufs: float
    true_peak_dbtp: float
    passed: bool
    failing_stems: List[str] = Field(default_factory=list)
    composite: float = Field(0.0, ge=0.0, le=1.0)
    failing_sections: List[str] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)


def chord_pitch_classes(symbol: str) -> set[int]:
    """Map a chord symbol (``Em``, ``Cmaj7``, ``G``) to pitch-class indices."""
    text = str(symbol or "").strip()
    if not text:
        return set()
    m = _CHORD_RE.match(text.replace(" ", ""))
    if not m:
        return set()
    root = m.group(1).upper()
    root = _FLAT_TO_SHARP.get(root, root)
    if root not in NOTE_NAMES:
        return set()
    root_pc = NOTE_NAMES.index(root)
    quality = (m.group(2) or "").lower().replace("maj", "").replace("min", "m")
    # Interval sets relative to root.
    if quality.startswith("dim") or "°" in quality:
        intervals = (0, 3, 6)
    elif quality.startswith("aug") or quality.startswith("+"):
        intervals = (0, 4, 8)
    elif quality.startswith("m7") or quality == "m":
        intervals = (0, 3, 7) if quality == "m" else (0, 3, 7, 10)
    elif "7" in quality or "9" in quality:
        intervals = (0, 4, 7, 10)
    elif quality.startswith("sus2"):
        intervals = (0, 2, 7)
    elif quality.startswith("sus4") or quality.startswith("sus"):
        intervals = (0, 5, 7)
    else:
        intervals = (0, 4, 7)
    return {(root_pc + i) % 12 for i in intervals}


def progression_chroma_template(chords: Sequence[str]) -> np.ndarray:
    """Average 12-D chroma template for a chord progression."""
    template = np.zeros(12, dtype=np.float64)
    count = 0
    for chord in chords:
        pcs = chord_pitch_classes(chord)
        if not pcs:
            continue
        for pc in pcs:
            template[pc] += 1.0
        count += 1
    if count == 0:
        return np.ones(12, dtype=np.float64) / 12.0
    template /= float(count)
    norm = float(np.linalg.norm(template))
    if norm > 1e-12:
        template /= norm
    return template


CHROMA_N_FFT_44K = 16384  # ~2.7 Hz bins at 44.1 kHz
CHROMA_MAX_HZ = 5000.0
# A bin only counts when a semitone spans at least this many bins there;
# below that, leakage lands on neighbouring pitch classes (~113 Hz at 44.1 kHz).
CHROMA_MIN_BINS_PER_SEMITONE = 2.5
# Bins further than this from a note centre are ambiguous and ignored.
CHROMA_MAX_DEVIATION_ST = 0.4
_SEMITONE_RATIO = 2.0 ** (1.0 / 12.0) - 1.0


def compute_chromagram(audio: np.ndarray, sr: int) -> np.ndarray:
    """Mean L1-normalised chromagram (12,) for harmonic scoring (librosa-free).

    Long frames (≈0.37 s) with power weighting, only bins close to a note
    centre, and a low-frequency limit where a semitone still spans
    ``CHROMA_MIN_BINS_PER_SEMITONE`` bins. Low notes (E2, B2 …) are carried by
    their harmonics instead of smearing their fundamentals across pitch
    classes.
    """
    mono = to_mono(audio)
    if mono.size < 16:
        return np.zeros(12, dtype=np.float64)
    sr_f = float(sr)
    n_fft = int(2 ** round(np.log2(max(256.0, CHROMA_N_FFT_44K * sr_f / 44100.0))))
    hop = n_fft // 2
    bin_hz = sr_f / n_fft
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr_f)
    min_hz = CHROMA_MIN_BINS_PER_SEMITONE * bin_hz / _SEMITONE_RATIO
    band = (freqs >= min_hz) & (freqs <= min(CHROMA_MAX_HZ, sr_f * 0.45))
    midi = 69.0 + 12.0 * np.log2(np.maximum(freqs[band], 1e-12) / 440.0)
    nearest = np.round(midi)
    close = np.abs(midi - nearest) <= CHROMA_MAX_DEVIATION_ST
    bins = np.flatnonzero(band)[close]
    pcs = np.mod(nearest[close].astype(np.int64), 12)

    if mono.size < n_fft:
        mono = np.pad(mono, (0, n_fft - mono.size))
    starts = range(0, mono.size - n_fft + 1, hop)
    window = np.hanning(n_fft)
    power = np.zeros(freqs.size, dtype=np.float64)
    chunk = 64
    starts_list = list(starts)
    for i in range(0, len(starts_list), chunk):
        frames = np.stack([mono[s : s + n_fft] for s in starts_list[i : i + chunk]])
        spec = np.fft.rfft(frames * window, axis=1)
        power += np.sum(spec.real**2 + spec.imag**2, axis=0)
    chroma = np.bincount(pcs, weights=power[bins], minlength=12).astype(np.float64)
    total = float(np.sum(chroma))
    return chroma / total if total > 1e-12 else chroma


def chroma_correlation(observed: np.ndarray, template: np.ndarray) -> float:
    """Share of chroma energy on template pitch classes, scaled against chance.

    ``ratio`` = energy on the template's notes / total energy. A flat chroma
    (white noise, drum wash) lands exactly on ``chance = k / 12`` for a
    ``k``-note template, so that maps to 0 and "all energy in key" maps to 1.
    Sparse in-key material (an E5 power chord against a 7-note progression)
    therefore scores high, unlike a cosine match that penalises sparsity.
    """
    chroma = np.clip(np.asarray(observed, dtype=np.float64).reshape(-1), 0.0, None)
    template_vector = np.asarray(template, dtype=np.float64).reshape(-1)
    if chroma.size != 12 or template_vector.size != 12:
        return 0.0
    if float(np.sum(chroma)) < 1e-12:
        return 0.0
    template_mask = (template_vector > 0).astype(np.float64)
    total_energy = float(np.sum(chroma)) + 1e-9
    in_template_energy = float(np.sum(chroma * template_mask))
    energy_ratio = in_template_energy / total_energy
    chance_floor = float(np.sum(template_mask)) / 12.0
    return float(
        np.clip((energy_ratio - chance_floor) / max(1e-6, 1.0 - chance_floor), 0.0, 1.0)
    )


def measure_integrated_lufs(audio: np.ndarray, sr: int) -> float:
    """Integrated loudness via pyloudnorm, with ITU-R BS.1770 fallback."""
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, np.newaxis]
    if data.size == 0:
        return -70.0
    try:
        import pyloudnorm as pyln

        meter = pyln.Meter(int(sr))
        value = float(meter.integrated_loudness(data))
        if np.isfinite(value):
            return value
    except Exception:
        pass
    try:
        from dsp.loudness_meter import measure_loudness

        return float(measure_loudness(data, int(sr)).integrated_lufs)
    except Exception:
        # Last-resort RMS approx so the gate still runs without loudness deps.
        rms = float(np.sqrt(np.mean(data * data) + 1e-12))
        return float(20.0 * np.log10(rms) - 0.691)


def measure_true_peak(audio: np.ndarray, sr: int) -> float:
    """True peak (dBTP), 4x oversampled when the limiter helper is available."""
    try:
        from dsp.true_peak_limiter import measure_true_peak_dbtp

        return float(measure_true_peak_dbtp(audio))
    except Exception:
        peak = float(np.max(np.abs(np.asarray(audio, dtype=np.float64))))
        return float(20.0 * np.log10(peak + 1e-12))


def spectral_band_ratios(audio: np.ndarray, sr: int) -> tuple[float, float]:
    """Return (mud_ratio, harsh_ratio) of band RMS vs full-band RMS."""
    full = max(1e-12, 10.0 ** (rms_dbfs(audio) / 20.0))
    mud = bandpass(audio, sr, MUD_BAND_HZ[0], MUD_BAND_HZ[1])
    harsh = bandpass(audio, sr, HARSH_BAND_HZ[0], HARSH_BAND_HZ[1])
    mud_r = max(0.0, 10.0 ** (rms_dbfs(mud) / 20.0)) / full
    harsh_r = max(0.0, 10.0 ** (rms_dbfs(harsh) / 20.0)) / full
    return float(mud_r), float(harsh_r)


def spectral_balance_score(audio: np.ndarray, sr: int) -> tuple[float, dict[str, float]]:
    """1.0 = clean; drops when mud (200-500) or harsh (3.5-6k) dominate."""
    mud_r, harsh_r = spectral_band_ratios(audio, sr)
    # Soft thresholds — above these the band is "excessive".
    mud_pen = max(0.0, (mud_r - 0.45) / 0.45)
    harsh_pen = max(0.0, (harsh_r - 0.35) / 0.35)
    score = float(np.clip(1.0 - 0.55 * mud_pen - 0.55 * harsh_pen, 0.0, 1.0))
    return score, {"mud_ratio": mud_r, "harsh_ratio": harsh_r}


def _section_from_mapping(raw: Mapping[str, Any] | SectionPlan | None) -> SectionPlan | None:
    if raw is None:
        return None
    if isinstance(raw, SectionPlan):
        return raw
    try:
        return SectionPlan.model_validate(dict(raw))
    except Exception:
        # Soft parse for partial test fixtures.
        try:
            return SectionPlan(
                name=str(raw.get("name") or "section"),
                start_bar=int(raw.get("start_bar") or 0),
                bars=int(raw.get("bars") or 4),
                energy_level=float(raw.get("energy_level") or raw.get("energy") or 0.5),
                chord_progression=list(raw.get("chord_progression") or []),
                active_stems=list(raw.get("active_stems") or []),
                frequency_reservations=dict(raw.get("frequency_reservations") or {}),
            )
        except Exception:
            return None


class SongEvaluator:
    """Production gatekeeper scorer for mixed stems + master."""

    def __init__(
        self,
        *,
        lufs_target: float = DEFAULT_LUFS_TARGET,
        true_peak_limit: float = DEFAULT_TRUE_PEAK_LIMIT,
        lufs_tolerance: float = LUFS_TOLERANCE_LU,
        composite_pass: float = COMPOSITE_PASS,
        check_loudness: bool = True,
    ) -> None:
        """``check_loudness=False`` for pre-master gating: integrated LUFS and
        true peak are still measured and reported, but neither the mix, any
        section, nor any stem fails on them (Module 5 owns compliance).
        """
        self.lufs_target = float(lufs_target)
        self.true_peak_limit = float(true_peak_limit)
        self.lufs_tolerance = float(lufs_tolerance)
        self.composite_pass = float(composite_pass)
        self.check_loudness = bool(check_loudness)

    def evaluate(
        self,
        mix: np.ndarray,
        sr: int,
        *,
        stems: Mapping[str, np.ndarray] | None = None,
        section: Mapping[str, Any] | SectionPlan | None = None,
        sections: Sequence[Mapping[str, Any] | SectionPlan] | None = None,
        song_plan: Mapping[str, Any] | None = None,
        scan_sections: bool = True,
    ) -> QualityScore:
        plan = song_plan or {}
        lufs_target = float(plan.get("master_lufs_target") or self.lufs_target)
        tp_limit = float(plan.get("true_peak_limit") or self.true_peak_limit)

        section_obj = _section_from_mapping(section)
        section_list = [
            s for s in (_section_from_mapping(item) for item in (sections or [])) if s is not None
        ]
        if section_obj is None and section_list:
            section_obj = max(section_list, key=lambda s: s.energy_level)

        harmonic = self._harmonic_coherence(mix, stems, section_obj, int(sr))
        spectral, spectral_detail = spectral_balance_score(mix, int(sr))
        lufs = measure_integrated_lufs(mix, int(sr))
        dbtp = measure_true_peak(mix, int(sr))

        failing_stems = self._flag_failing_stems(stems, section_obj, int(sr), lufs_target, tp_limit)
        failing_sections: list[str] = []
        if scan_sections:
            failing_sections = self._flag_failing_sections(
                mix,
                stems,
                section_list or ([section_obj] if section_obj else []),
                int(sr),
                plan,
            )

        loudness_ok = (not self.check_loudness) or (
            abs(lufs - lufs_target) <= self.lufs_tolerance and dbtp <= tp_limit + 1e-6
        )
        # Map loudness gap into 0..1 (1 = on target / under peak).
        lufs_score = 1.0 if not self.check_loudness else float(
            np.clip(1.0 - abs(lufs - lufs_target) / max(self.lufs_tolerance * 2.0, 1e-6), 0.0, 1.0)
        )
        peak_score = 1.0 if (not self.check_loudness or dbtp <= tp_limit) else float(
            np.clip(1.0 - (dbtp - tp_limit) / 6.0, 0.0, 1.0)
        )
        loudness_score = 0.6 * lufs_score + 0.4 * peak_score

        composite = float(
            np.clip(0.40 * harmonic + 0.30 * spectral + 0.30 * loudness_score, 0.0, 1.0)
        )
        passed = (
            composite >= self.composite_pass
            and loudness_ok
            and harmonic >= HARMONIC_PASS
            and spectral >= 0.55
            and not failing_stems
        )

        return QualityScore(
            harmonic_coherence=round(harmonic, 4),
            spectral_balance=round(spectral, 4),
            integrated_lufs=round(lufs, 3),
            true_peak_dbtp=round(dbtp, 3),
            passed=bool(passed),
            failing_stems=list(failing_stems),
            composite=round(composite, 4),
            failing_sections=list(failing_sections),
            details={
                "lufs_target": lufs_target,
                "true_peak_limit": tp_limit,
                "loudness_checked": self.check_loudness,
                "loudness_ok": loudness_ok,
                "spectral": spectral_detail,
                "section": section_obj.name if section_obj else None,
            },
        )

    def _harmonic_coherence(
        self,
        mix: np.ndarray,
        stems: Mapping[str, np.ndarray] | None,
        section: SectionPlan | None,
        sr: int,
    ) -> float:
        chords = list(section.chord_progression) if section else []
        template = progression_chroma_template(chords)
        # Prefer melodic stems; fall back to the master mix.
        observed = np.zeros(12, dtype=np.float64)
        used = 0
        if stems:
            for bus in MELODIC_BUSES:
                audio = stems.get(bus)
                if audio is None or np.asarray(audio).size == 0:
                    continue
                if rms_dbfs(audio) < -55.0:
                    continue
                observed += compute_chromagram(audio, sr)
                used += 1
        if used == 0:
            observed = compute_chromagram(mix, sr)
        else:
            observed /= float(used)
        return chroma_correlation(observed, template)

    def _flag_failing_stems(
        self,
        stems: Mapping[str, np.ndarray] | None,
        section: SectionPlan | None,
        sr: int,
        lufs_target: float,
        tp_limit: float,
    ) -> list[str]:
        if not stems:
            return []
        failing: list[str] = []
        chords = list(section.chord_progression) if section else []
        template = progression_chroma_template(chords) if chords else None
        for name, audio in stems.items():
            if audio is None or np.asarray(audio).size == 0:
                continue
            if rms_dbfs(audio) < -60.0:
                continue
            # Peak clip on any stem (post-master only; pre-master buses run in
            # float headroom that the finalize/master stages trim).
            if self.check_loudness and measure_true_peak(audio, sr) > tp_limit:
                failing.append(str(name))
                continue
            # Melodic stems that fight the progression.
            if template is not None and name in MELODIC_BUSES:
                corr = chroma_correlation(compute_chromagram(audio, sr), template)
                if corr < STEM_HARMONIC_FLAG:
                    failing.append(str(name))
                    continue
            # Spectral mud/harsh on harmonic competitors.
            if name in {"harmonic", "rhythm"}:
                bal, _ = spectral_balance_score(audio, sr)
                if bal < 0.45:
                    failing.append(str(name))
        # Stable unique order.
        return list(dict.fromkeys(failing))

    def _flag_failing_sections(
        self,
        mix: np.ndarray,
        stems: Mapping[str, np.ndarray] | None,
        sections: Sequence[SectionPlan],
        sr: int,
        song_plan: Mapping[str, Any],
    ) -> list[str]:
        if not sections:
            return []
        bpm = float(song_plan.get("bpm") or 120.0)
        bar_samples = float(sr) * 60.0 * beats_per_bar(song_plan.get("time_signature")) / max(1.0, bpm)
        failing: list[str] = []
        mix_arr = np.asarray(mix)
        n = mix_arr.shape[0] if mix_arr.ndim >= 1 else 0
        for section in sections:
            start = int(round(int(section.start_bar) * bar_samples))
            end = start + int(round(int(section.bars) * bar_samples))
            if start >= n:
                continue
            end = min(n, max(start + 1, end))
            slice_mix = mix_arr[start:end]
            slice_stems = None
            if stems:
                slice_stems = {
                    k: np.asarray(v)[start:end]
                    for k, v in stems.items()
                    if v is not None and np.asarray(v).shape[0] >= end
                }
            score = self.evaluate(
                slice_mix,
                sr,
                stems=slice_stems,
                section=section,
                song_plan=song_plan,
                scan_sections=False,
            )
            if (not score.passed) or score.composite < self.composite_pass:
                failing.append(section.name)
        return list(dict.fromkeys(failing))
