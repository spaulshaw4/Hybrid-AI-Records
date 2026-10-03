"""Mix-bus crest factor control: macro gain riding plus a linked soft clipper.

The arranged mix hands the master chain a peak-to-loudness ratio around 24 dB
because a handful of fill bars sit 15 dB above the rest of the song. Nothing
downstream can recover that: the mastering limiter's push is bounded by
true-peak headroom, so a 24 dB PLR mix lands 6-10 dB short of the -14 LUFS
delivery target no matter how hard the limiter is driven.

Two linked stages bring the mix in at a deliverable PLR:

* a slow gain ride that pulls the isolated hot bars back toward the body of
  the song, which is where nearly all of the excess crest lives, and
* a soft clipper that rounds off the residual sample-level transients.

Both stages derive a single broadband gain from ``max(|L|, |R|)`` and apply it
to every channel, so the inter-channel ratio — and therefore the mono
fold-down correlation — is left exactly as the mixer set it. Everything is
closed-form numpy with no randomness, so a seeded render stays reproducible.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import maximum_filter1d

from engine.song_evaluator import measure_integrated_lufs

EPS = 1e-12

# A delivered master sits at -1 dBTP / -14 LUFS, i.e. 13 dB PLR. The soft
# clipper asymptotes rather than reaching its ceiling and both stages shave a
# little loudness, so aiming here measures out at roughly 14.8 dB on real
# mixes — about 2 dB of honest work for the limiter instead of the 11 dB it
# cannot do.
DEFAULT_TARGET_PLR_DB = 13.0
# Anything already inside target + this stays untouched, so well-behaved
# material is a bit-exact no-op rather than being squashed for no reason.
PLR_TOLERANCE_DB = 1.0
# Macro riding is transparent up to roughly a fader move; past that it starts
# to read as the arrangement changing rather than the engineer riding it.
MAX_LEVEL_DB = 12.0
# Knee width handed to the clipper, i.e. how far the ride leaves peaks above
# the ceiling. 3 dB of soft clipping on the top 0.1 % of samples is inaudible;
# a wider knee starts to dull the drum transients. Material that exhausts the
# ride budget still clips further, since the tanh has no hard stop.
CLIP_KNEE_DB = 3.0
LEVEL_HOP_MS = 10.0
# Hold the full reduction across an event before ramping out of it, so a fill
# is ridden at one level instead of being modulated bar by bar.
LEVEL_HOLD_MS = 120.0
# Ramp length. Long enough that the ride sits below the pumping range, short
# enough that it does not duck the bars either side of a fill.
LEVEL_SMOOTH_MS = 250.0


@dataclass
class CrestReport:
    """What the stage measured and did, for the render log and the trace."""

    plr_before_db: float
    plr_after_db: float
    lufs_before: float
    peak_before_dbfs: float
    peak_after_dbfs: float
    level_reduction_db: float
    clip_reduction_db: float
    engaged: bool


def _as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    return data, False


def _db(value: float) -> float:
    return float(20.0 * np.log10(max(float(value), EPS)))


def _odd(samples: int) -> int:
    samples = max(1, int(samples))
    return samples if samples % 2 else samples + 1


def _macro_gain(
    envelope: np.ndarray,
    sr: int,
    ceiling_db: float,
    max_reduction_db: float,
) -> tuple[np.ndarray, float]:
    """Gain curve that rides blocks above ``ceiling_db`` back down to it.

    Detection runs on 10 ms block peaks; the reduction is held across the
    event and then smoothed with a zero-phase Hann window, which ramps into
    and out of the ride symmetrically. A causal attack would have to either
    overshoot on the first hit or clamp down audibly, and the whole point of
    this stage is that the limiter should not hear a step.
    """
    n = int(envelope.size)
    hop = max(1, int(round(sr * LEVEL_HOP_MS / 1000.0)))
    blocks = int(np.ceil(n / hop))
    padded = np.zeros(blocks * hop, dtype=np.float64)
    padded[:n] = envelope
    block_peak = padded.reshape(blocks, hop).max(axis=1)

    over_db = 20.0 * np.log10(np.maximum(block_peak, EPS)) - float(ceiling_db)
    np.clip(over_db, 0.0, float(max_reduction_db), out=over_db)
    if not np.any(over_db > 0.0):
        return np.ones(n, dtype=np.float64), 0.0

    hold = _odd(round(LEVEL_HOLD_MS / LEVEL_HOP_MS))
    over_db = maximum_filter1d(over_db, size=hold, mode="nearest")
    window = np.hanning(_odd(round(LEVEL_SMOOTH_MS / LEVEL_HOP_MS)) + 2)[1:-1]
    window /= window.sum()
    pad = window.size // 2
    over_db = np.convolve(np.pad(over_db, pad, mode="edge"), window, mode="valid")

    applied = float(np.max(over_db))
    centres = np.arange(blocks, dtype=np.float64) * hop + 0.5 * (hop - 1)
    gain_db = -np.interp(np.arange(n, dtype=np.float64), centres, over_db)
    return np.power(10.0, gain_db / 20.0), applied


def _clipper_gain(envelope: np.ndarray, ceiling: float) -> tuple[np.ndarray, float]:
    """Linked soft clip: everything asymptotes to ``ceiling`` but never reaches it.

    ``tanh`` above the knee keeps the first derivative continuous, so the
    harmonics it adds fall off smoothly instead of the odd-order buzz a hard
    knee produces on sustained material.
    """
    knee = float(ceiling) * (1.0 - 10.0 ** (-CLIP_KNEE_DB / 20.0))
    threshold = float(ceiling) - knee
    if knee <= EPS:
        return np.ones(envelope.size, dtype=np.float64), 0.0
    hot = envelope > threshold
    if not np.any(hot):
        return np.ones(envelope.size, dtype=np.float64), 0.0
    gain = np.ones(envelope.size, dtype=np.float64)
    over = envelope[hot]
    gain[hot] = (threshold + knee * np.tanh((over - threshold) / knee)) / over
    return gain, -_db(float(np.min(gain[hot])))


def control_crest(
    audio: np.ndarray,
    sr: int,
    *,
    target_plr_db: float = DEFAULT_TARGET_PLR_DB,
    max_level_db: float = MAX_LEVEL_DB,
) -> tuple[np.ndarray, np.ndarray, CrestReport]:
    """Bring ``audio`` to roughly ``target_plr_db`` peak-to-loudness ratio.

    Returns ``(processed, gain, report)``. ``gain`` is the ``(n, 1)`` broadband
    curve that was applied, so callers can put the stems through the same ride
    and keep them summing to the mix.
    """
    frames, was_1d = _as_frames(audio)
    n = int(frames.shape[0])
    unity = np.ones((max(n, 0), 1), dtype=np.float64)
    envelope = np.max(np.abs(frames), axis=1) if n else np.zeros(0)
    peak = float(np.max(envelope)) if n else 0.0
    lufs = measure_integrated_lufs(frames, int(sr)) if n else -np.inf
    idle = CrestReport(
        plr_before_db=0.0,
        plr_after_db=0.0,
        lufs_before=float(lufs),
        peak_before_dbfs=_db(peak),
        peak_after_dbfs=_db(peak),
        level_reduction_db=0.0,
        clip_reduction_db=0.0,
        engaged=False,
    )
    # Silence and near-silence have no meaningful crest to control.
    if n == 0 or peak <= EPS or not np.isfinite(lufs) or lufs <= -70.0:
        return np.asarray(audio, dtype=np.float64), unity, idle

    plr_before = _db(peak) - float(lufs)
    idle.plr_before_db = round(plr_before, 2)
    idle.plr_after_db = round(plr_before, 2)
    if plr_before <= float(target_plr_db) + PLR_TOLERANCE_DB:
        return np.asarray(audio, dtype=np.float64), unity, idle

    # Peak the mix should end up at to read as target_plr_db against its own
    # integrated loudness. The ride hands everything within one clipper knee
    # of that ceiling over to the clipper.
    ceiling_db = float(lufs) + float(target_plr_db)
    gain, level_db = _macro_gain(envelope, int(sr), ceiling_db + CLIP_KNEE_DB, float(max_level_db))
    clip_gain, clip_db = _clipper_gain(envelope * gain, 10.0 ** (ceiling_db / 20.0))
    gain *= clip_gain

    # Static makeup back to the original sample peak. Removing crest without it
    # would just make the mix quieter, since the headroom stage downstream only
    # ever attenuates; matching the peak exactly also means the stage cannot
    # introduce a true-peak overshoot it did not inherit.
    shaped_peak = float(np.max(envelope * gain))
    if shaped_peak > EPS:
        gain *= peak / shaped_peak

    shaped = gain[:, np.newaxis]
    out = frames * shaped
    peak_after = float(np.max(np.abs(out)))
    lufs_after = measure_integrated_lufs(out, int(sr))
    report = CrestReport(
        plr_before_db=round(plr_before, 2),
        plr_after_db=round(_db(peak_after) - float(lufs_after), 2),
        lufs_before=round(float(lufs), 2),
        peak_before_dbfs=round(_db(peak), 2),
        peak_after_dbfs=round(_db(peak_after), 2),
        level_reduction_db=round(level_db, 2),
        clip_reduction_db=round(clip_db, 2),
        engaged=True,
    )
    return (out[:, 0] if was_1d else out), shaped, report
