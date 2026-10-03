"""Harmonic + rhythmic content per slice — the features selection was missing.

``slice_index`` stores one ``detected_key`` root and one ``estimated_bpm`` scalar
per slice. That is not enough to honour a harmonic roadmap ("bar 20 is Fmaj7")
or a groove ("this chorus wants four-on-the-floor"). This module measures the
content itself:

* **chroma** — 12-bin pitch-class profile. Lets the picker ask "do this slice's
  notes fit Fmaj7", instead of "is its root near A".
* **onset grid** — 16 accent buckets over one bar plus the downbeat phase, so a
  section can request an accent pattern and get one.

numpy + scipy only; librosa/numba are unreliable on this workstation. Keyed on
``slice_index.file_path`` so the join back to the corpus index is exact.
"""
from __future__ import annotations

import numpy as np
from scipy import fft as sp_fft

from ml.audio_features import (
    EPS,
    HOP,
    N_FFT,
    TARGET_SR,
    _magnitude_spectrogram,
    resample_to_target,
    to_mono,
)

PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
GRID_STEPS = 16

# Chroma needs its own window. The shared 1024-point FFT has 21.5 Hz bins,
# but a semitone at 330 Hz is 19.6 Hz wide, so E3 snaps to the F bin. At 8192
# the spacing is 2.7 Hz, which resolves semitones down to ~55 Hz (A1).
CHROMA_N_FFT = 8192
CHROMA_HOP = 2048

# Krumhansl-Schmuckler profiles, normalised at use. Root detection only; the
# picker scores against explicit chord tones, not these.
_MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)

# Chord quality -> semitone offsets from the root.
CHORD_INTERVALS: dict[str, tuple[int, ...]] = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "dim": (0, 3, 6),
    "aug": (0, 4, 8),
    "maj7": (0, 4, 7, 11),
    "min7": (0, 3, 7, 10),
    "7": (0, 4, 7, 10),
    "dim7": (0, 3, 6, 9),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
    "5": (0, 7),
}

# Bin -> pitch class map for the chroma window, built once. Below 55 Hz the
# bins stop resolving semitones; above 5 kHz the content is overtones/noise.
_PITCH_MIN_HZ = 55.0
_PITCH_MAX_HZ = 5000.0
_CHROMA_FREQS = np.fft.rfftfreq(CHROMA_N_FFT, 1.0 / TARGET_SR)
_chroma_valid = (_CHROMA_FREQS >= _PITCH_MIN_HZ) & (_CHROMA_FREQS <= _PITCH_MAX_HZ)
_chroma_midi = 69.0 + 12.0 * np.log2(np.maximum(_CHROMA_FREQS, EPS) / 440.0)
_CHROMA_BIN_PC = np.where(_chroma_valid, np.rint(_chroma_midi).astype(np.int64) % 12, -1)
_PC_MASKS = tuple((_CHROMA_BIN_PC == pc) for pc in range(12))
_CHROMA_WINDOW = np.hanning(CHROMA_N_FFT)


def chroma_vector(mono: np.ndarray, sr: int) -> np.ndarray:
    """12-bin pitch-class profile, L1-normalised. Zeros on silence.

    Magnitude rather than power: power lets one loud low partial swamp the
    chord, which is exactly the misread this replaces.
    """
    mono = to_mono(mono)
    if mono.size == 0 or sr <= 0:
        return np.zeros(12, dtype=np.float64)
    mono = resample_to_target(mono, int(sr), TARGET_SR)
    if mono.size < CHROMA_N_FFT:
        mono = np.pad(mono, (0, CHROMA_N_FFT - mono.size))
    n_frames = max(1, 1 + (mono.size - CHROMA_N_FFT) // CHROMA_HOP)
    idx = np.arange(CHROMA_N_FFT)[None, :] + CHROMA_HOP * np.arange(n_frames)[:, None]
    mag = np.abs(sp_fft.rfft(mono[idx] * _CHROMA_WINDOW[None, :], axis=1))
    energy = mag.sum(axis=0)
    chroma = np.array([float(energy[mask].sum()) for mask in _PC_MASKS], dtype=np.float64)
    total = float(chroma.sum())
    if total <= EPS:
        return np.zeros(12, dtype=np.float64)
    return chroma / total


def estimate_root(chroma: np.ndarray) -> tuple[int, bool, float]:
    """(root pitch class, is_minor, confidence 0..1) via profile correlation."""
    chroma = np.asarray(chroma, dtype=np.float64)
    if chroma.size != 12 or float(chroma.sum()) <= EPS:
        return -1, False, 0.0
    scores: list[tuple[float, int, bool]] = []
    for pc in range(12):
        rotated = np.roll(chroma, -pc)
        for profile, minor in ((_MAJOR_PROFILE, False), (_MINOR_PROFILE, True)):
            prof = profile / profile.sum()
            a = rotated - rotated.mean()
            b = prof - prof.mean()
            denom = float(np.linalg.norm(a) * np.linalg.norm(b)) + EPS
            scores.append((float(np.dot(a, b) / denom), pc, minor))
    scores.sort(reverse=True)
    best, root, minor = scores[0]
    runner = scores[1][0] if len(scores) > 1 else 0.0
    # Confidence = how decisively the winner beat the next candidate.
    confidence = max(0.0, min(1.0, float(best - runner) * 2.0))
    return int(root), bool(minor), confidence


_FLAT_TO_SHARP = {"DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#", "CB": "B", "FB": "E"}

_QUALITY_ALIASES = {
    "": "maj",
    "major": "maj",
    "m": "min",
    "-": "min",
    "minor": "min",
    "m7": "min7",
    "min9": "min7",
    "maj9": "maj7",
    "dom7": "7",
}


def chord_pitch_classes(chord: str) -> tuple[int, ...]:
    """Parse ``Fmaj7`` / ``Am7`` / ``Bb`` / ``G`` into absolute pitch classes."""
    text = str(chord or "").strip()
    if not text:
        return ()
    head = text[:2].upper()
    if head in _FLAT_TO_SHARP:
        root_txt, rest = _FLAT_TO_SHARP[head], text[2:]
    elif len(text) > 1 and text[1] == "#":
        root_txt, rest = text[:2].upper(), text[2:]
    else:
        root_txt, rest = text[:1].upper(), text[1:]
    if root_txt not in PITCH_CLASSES:
        return ()
    root = PITCH_CLASSES.index(root_txt)
    quality = rest.strip().lower()
    quality = _QUALITY_ALIASES.get(quality, quality)
    intervals = CHORD_INTERVALS.get(quality)
    if intervals is None:
        # Unknown extension: fall back to the triad its prefix implies.
        intervals = CHORD_INTERVALS["min"] if quality.startswith("m") else CHORD_INTERVALS["maj"]
    return tuple((root + i) % 12 for i in intervals)


NEUTRAL_FIT = 0.5

# Below this confidence the pitch reading is not worth scoring on at all: the
# winning key profile barely beat the runner-up, so the "fit" it reports is as
# likely to be noise as signal. Callers withhold the harmonic opinion entirely
# for such a slice (see ``engine.stem_selector.score_candidate``) instead of
# ranking it on a measurement they cannot trust. Named because it is set above
# the corpus mean (0.212) and so bypasses most of it: 280,202 of 1,385,549
# slices clear it (20.2%), and per role 20.6% of harmonic / 16.6% of vocal /
# 11.6% of rhythm candidates do. Retune here if that proves too aggressive.
CONFIDENCE_BYPASS = 0.35

# Confidence at which a surviving reading is trusted outright. ``estimate_root``
# returns a margin between the winning and runner-up key profile, not a
# probability, and across the 1,385,549-slice corpus it is squashed low: mean
# 0.212, median 0.176, p90 0.452, p99 0.662, max 0.930. Scaling against the p90
# keeps the decisively-measured top decile at full strength while still
# separating the band that clears the bypass (trust runs 0.78 -> 1.0 from 0.35
# to 0.45). Using the raw confidence as trust would leave even the best-read
# slice in the corpus 55% neutral and flatten the component out of existence.
CONFIDENCE_REFERENCE = 0.45


def harmonic_bypass(confidence: float | None) -> bool:
    """True when a reading is too uncertain to let it move a ranking.

    ``None`` is not a bypass: the only rows that reach a fit function without a
    confidence measured their chroma somewhere other than ``slice_musical``
    (staged audio, fixtures). A slice simply absent from ``slice_musical``
    carries no chroma either, so it already returns the neutral fit.
    """
    if confidence is None:
        return False
    try:
        value = float(confidence)
    except (TypeError, ValueError):
        return False
    return not np.isfinite(value) or value < CONFIDENCE_BYPASS


def confidence_trust(confidence: float | None) -> float:
    """Map raw ``chroma_confidence`` onto 0..1 trust in the measurement."""
    if harmonic_bypass(confidence):
        return 0.0
    if confidence is None:
        return 1.0
    try:
        value = float(confidence)
    except (TypeError, ValueError):
        return 1.0
    return float(min(1.0, value / CONFIDENCE_REFERENCE))


def _blend_toward_neutral(fit: float, confidence: float | None) -> float:
    """Pull a fit toward neutral in proportion to how trustworthy it is.

    Blending rather than multiplying: at zero trust the slice scores the same
    0.5 an unmeasured slice gets, so "unmeasurable" and "unmeasured" behave
    identically. Multiplying by a mean-0.212 confidence would instead drag
    every candidate toward zero and delete the component.
    """
    trust = confidence_trust(confidence)
    if trust >= 1.0:
        return float(fit)
    return float(NEUTRAL_FIT + (float(fit) - NEUTRAL_FIT) * trust)


def chord_fit(chroma: np.ndarray, chord: str, confidence: float | None = None) -> float:
    """Fraction of a slice's pitch energy that lands on the chord's tones.

    1.0 = every partial belongs to the chord, 0.0 = none of it does. Returns
    the neutral 0.5 when either side is unknown, so a missing measurement never
    looks worse than a genuine clash.

    ``confidence`` is the slice's ``chroma_confidence``. A weak reading is
    blended toward neutral so it can neither win on noise nor be punished for
    a clash it may not actually have, and one under ``CONFIDENCE_BYPASS``
    returns the neutral value outright.
    """
    tones = chord_pitch_classes(chord)
    arr = np.asarray(chroma, dtype=np.float64)
    if not tones or arr.size != 12:
        return 0.5
    total = float(arr.sum())
    if total <= EPS:
        return 0.5
    return _blend_toward_neutral(float(sum(arr[t] for t in tones) / total), confidence)


def plan_pitch_weights(chords) -> np.ndarray:
    """How much each pitch class matters across a whole progression.

    Stems are staged once per role for the entire track, so a single pick
    cannot satisfy every bar's chord. Weighting the roadmap's chords by how
    often they are held gives one target the whole song can be scored against:
    a slice sitting on the progression's tones fits everywhere, one full of
    outside notes fits nowhere.
    """
    weights = np.zeros(12, dtype=np.float64)
    for chord in chords or ():
        tones = chord_pitch_classes(str(chord))
        if not tones:
            continue
        # Root carries the most weight, the rest share the remainder.
        for position, pc in enumerate(tones):
            weights[pc] += 1.5 if position == 0 else 1.0
    total = float(weights.sum())
    if total <= EPS:
        return np.zeros(12, dtype=np.float64)
    return weights / total


def harmonic_fit(
    chroma: np.ndarray, weights: np.ndarray, confidence: float | None = None
) -> float:
    """How much of a slice's pitch energy lands on a progression's tones.

    Neutral 0.5 when either side is unmeasured, so an un-analysed slice is
    never ranked below one that genuinely clashes. ``confidence`` blends the
    result toward that same neutral as the chroma reading gets less reliable,
    and returns it outright below ``CONFIDENCE_BYPASS``.
    """
    c = np.asarray(chroma, dtype=np.float64)
    w = np.asarray(weights, dtype=np.float64)
    if c.size != 12 or w.size != 12:
        return 0.5
    if float(c.sum()) <= EPS or float(w.sum()) <= EPS:
        return 0.5
    # Energy-weighted overlap, normalised by the best achievable score so a
    # progression using many pitch classes is not penalised for being rich.
    overlap = float(np.dot(c, w))
    best = float(np.max(w))
    if best <= EPS:
        return 0.5
    return _blend_toward_neutral(max(0.0, min(1.0, overlap / best)), confidence)


def onset_grid(mono: np.ndarray, sr: int, bpm: float, steps: int = GRID_STEPS) -> np.ndarray:
    """Accent energy folded onto ``steps`` buckets of one bar, peak-normalised.

    A four-on-the-floor loop puts mass on steps 0/4/8/12; a half-time loop on
    0/8. Zeros when tempo is unknown, so callers can treat it as "no opinion".
    """
    mono = to_mono(mono)
    if mono.size == 0 or sr <= 0 or not bpm or bpm <= 0:
        return np.zeros(steps, dtype=np.float64)
    sr_i = int(sr)
    mono = resample_to_target(mono, sr_i, TARGET_SR)
    mag = _magnitude_spectrogram(mono)
    if mag.shape[0] < 2:
        return np.zeros(steps, dtype=np.float64)
    flux = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
    # flux[i] is the rise into frame i+1; time it at that frame's centre. Using
    # the frame start reports every onset up to one window early.
    frame_times = ((np.arange(flux.size) + 1) * HOP + N_FFT / 2.0) / float(TARGET_SR)
    bar_sec = 4.0 * 60.0 / float(bpm)
    if bar_sec <= 0:
        return np.zeros(steps, dtype=np.float64)
    # Round to the nearest grid position: a hit just ahead of the beat belongs
    # to that beat, and floor() would drop it into the previous bucket.
    bucket = np.rint((frame_times % bar_sec) / bar_sec * steps).astype(np.int64) % steps
    grid = np.zeros(steps, dtype=np.float64)
    np.add.at(grid, bucket, flux)
    peak = float(grid.max())
    if peak <= EPS:
        return np.zeros(steps, dtype=np.float64)
    return grid / peak


def downbeat_phase(grid: np.ndarray) -> float:
    """Where in the bar this loop's strongest accent sits, in 0..1."""
    arr = np.asarray(grid, dtype=np.float64)
    if arr.size == 0 or float(arr.sum()) <= EPS:
        return 0.0
    return float(int(np.argmax(arr)) / arr.size)


def groove_fit(grid: np.ndarray, target: np.ndarray) -> float:
    """Cosine similarity between two accent patterns, in 0..1.

    Neutral 0.5 when either pattern is unmeasured.
    """
    a = np.asarray(grid, dtype=np.float64)
    b = np.asarray(target, dtype=np.float64)
    if a.size != b.size or a.size == 0:
        return 0.5
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na <= EPS or nb <= EPS:
        return 0.5
    return float(max(0.0, min(1.0, np.dot(a, b) / (na * nb))))


def pack_floats(values) -> str:
    """Compact text encoding for a small float vector (SQLite column)."""
    return ",".join(f"{float(v):.5f}" for v in np.asarray(values).ravel())


def unpack_floats(text: str | None, size: int) -> np.ndarray:
    """Inverse of :func:`pack_floats`. Zeros when absent or malformed."""
    if not text:
        return np.zeros(size, dtype=np.float64)
    try:
        arr = np.array([float(p) for p in str(text).split(",") if p], dtype=np.float64)
    except ValueError:
        return np.zeros(size, dtype=np.float64)
    if arr.size != size:
        return np.zeros(size, dtype=np.float64)
    return arr
