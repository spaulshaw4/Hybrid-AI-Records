"""Native bus processor approximating LANDR-style tonal shaping.

This is a pure NumPy/SciPy fallback when external VST3 hosting is unavailable.

v2 additions
------------
* ``_asymmetric_saturate`` – even-order (tube-style) and odd-order harmonics.
* ``_dynamic_deess``       – sidechain envelope follower for sibilance control.
* ``_dual_band_bass_split``– sub protection with upper-bass saturation drive.
* Updated bus routing matrix for voice, electric, beats, and bass.

v3 additions
------------
* ``_harmonic_exciter``    – synthesises new upper harmonics above 4.5 kHz
                             (LANDR ReHance-style); applied on voice bus.
* ``_midside_imaging``     – M/S stereo-width control with sub-mono enforcement
                             below 140 Hz (LANDR Mastering PRO-style).
* ``_vca_compress``        – feed-forward VCA compressor with attack/release
                             ballistics (Tone Empire Model 5000-style);
                             applied on beats bus.
* ``_cab_sim_eq``          – 4×12 speaker cabinet resonance model (85 Hz thump,
                             500 Hz scoop, 3.8 kHz bite, 5.5 kHz LP roll-off);
                             applied on electric bus replacing the plain shelf.
"""

from __future__ import annotations

import numpy as np
import scipy.signal as signal


class NativeAudioEngine:
    def __init__(self, sample_rate: int = 44100):
        self.sr = int(sample_rate)

    # ------------------------------------------------------------------ #
    # Core filter primitives                                               #
    # ------------------------------------------------------------------ #

    def _biquad_peaking(self, gain_db: float, freq_hz: float, q: float = 1.0):
        """Audio EQ Cookbook peaking EQ coefficients."""
        a_gain = 10 ** (gain_db / 40.0)
        w0 = 2 * np.pi * freq_hz / self.sr
        alpha = np.sin(w0) / (2 * q)

        b0 = 1 + alpha * a_gain
        b1 = -2 * np.cos(w0)
        b2 = 1 - alpha * a_gain
        a0 = 1 + alpha / a_gain
        a1 = -2 * np.cos(w0)
        a2 = 1 - alpha / a_gain

        b = np.array([b0, b1, b2], dtype=np.float64) / a0
        a = np.array([a0, a1, a2], dtype=np.float64) / a0
        return b, a

    def _biquad_shelf(
        self,
        gain_db: float,
        freq_hz: float,
        shelf_type: str = "high",
        q: float = 0.707,
    ):
        """High- or low-shelf filter coefficients."""
        a_gain = 10 ** (gain_db / 40.0)
        w0 = 2 * np.pi * freq_hz / self.sr
        alpha = np.sin(w0) / (2 * q)
        cos_w = np.cos(w0)
        two_sqrt_a_alpha = 2 * np.sqrt(a_gain) * alpha

        if shelf_type == "high":
            b0 = a_gain * ((a_gain + 1) + (a_gain - 1) * cos_w + two_sqrt_a_alpha)
            b1 = -2 * a_gain * ((a_gain - 1) + (a_gain + 1) * cos_w)
            b2 = a_gain * ((a_gain + 1) + (a_gain - 1) * cos_w - two_sqrt_a_alpha)
            a0 = (a_gain + 1) - (a_gain - 1) * cos_w + two_sqrt_a_alpha
            a1 = 2 * ((a_gain - 1) - (a_gain + 1) * cos_w)
            a2 = (a_gain + 1) - (a_gain - 1) * cos_w - two_sqrt_a_alpha
        else:
            b0 = a_gain * ((a_gain + 1) - (a_gain - 1) * cos_w + two_sqrt_a_alpha)
            b1 = 2 * a_gain * ((a_gain - 1) - (a_gain + 1) * cos_w)
            b2 = a_gain * ((a_gain + 1) - (a_gain - 1) * cos_w - two_sqrt_a_alpha)
            a0 = (a_gain + 1) + (a_gain - 1) * cos_w + two_sqrt_a_alpha
            a1 = -2 * ((a_gain - 1) + (a_gain + 1) * cos_w)
            a2 = (a_gain + 1) + (a_gain - 1) * cos_w - two_sqrt_a_alpha

        b = np.array([b0, b1, b2], dtype=np.float64) / a0
        a = np.array([a0, a1, a2], dtype=np.float64) / a0
        return b, a

    # ------------------------------------------------------------------ #
    # Upgraded saturation / dynamics modules                               #
    # ------------------------------------------------------------------ #

    def _soft_clip(self, audio: np.ndarray, drive: float = 1.0) -> np.ndarray:
        """Simple symmetric tanh soft saturation (legacy helper)."""
        if drive <= 1.0:
            return audio
        return np.tanh(audio * drive) / np.tanh(drive)

    def _asymmetric_saturate(
        self,
        audio: np.ndarray,
        drive: float = 1.2,
        asymmetry: float = 0.18,
    ) -> np.ndarray:
        """Even-order (tube-style) and odd-order harmonics simultaneously.

        An asymmetric x² term is injected before the tanh compression so the
        curve is no longer an odd function. This generates real even harmonics
        (2nd, 4th, …) alongside the usual odd harmonics of tanh, giving a
        warmer, more complex character than a plain symmetric clipper.
        """
        if drive <= 1.0:
            return audio
        shaped = audio + asymmetry * (audio ** 2 - float(np.mean(audio ** 2)))
        driven = shaped * drive
        return np.tanh(driven) / np.tanh(drive)

    def _dynamic_deess(
        self,
        audio: np.ndarray,
        sidechain_freq: float = 7000.0,
        threshold_db: float = -18.0,
        max_cut_db: float = 6.0,
    ) -> np.ndarray:
        """Dynamic high-frequency envelope follower that attenuates sibilance.

        Detects energy in the sidechain band with a 10 ms RMS window, then
        blends a high-shelf attenuated copy against the dry signal in proportion
        to how much the detected envelope exceeds the threshold.
        """
        nyq = self.sr / 2.0
        bw = 1500.0
        lo = max(20.0, sidechain_freq - bw)
        hi = min(nyq - 100.0, sidechain_freq + bw)

        sos_bp = signal.butter(
            2, [lo, hi], btype="bandpass", fs=self.sr, output="sos"
        )
        detected = signal.sosfilt(sos_bp, audio)

        env = np.abs(detected)
        win = max(1, int(self.sr * 0.010))
        env = np.convolve(env, np.ones(win) / win, mode="same")

        thresh = 10 ** (threshold_db / 20.0)
        over = np.maximum(0.0, env - thresh)
        norm_over = np.clip(over / (thresh + 1e-9), 0.0, 1.0)
        gain_reduction = 10 ** (-(norm_over * max_cut_db) / 20.0)

        b_cut, a_cut = self._biquad_shelf(
            gain_db=-max_cut_db, freq_hz=sidechain_freq, shelf_type="high"
        )
        filtered_high = signal.lfilter(b_cut, a_cut, audio)

        return audio * gain_reduction + filtered_high * (1.0 - gain_reduction)

    def _dual_band_bass_split(
        self,
        audio: np.ndarray,
        crossover_hz: float = 120.0,
        drive: float = 1.5,
    ) -> np.ndarray:
        """Protect clean sub fundamentals while driving upper-bass growl.

        Splits at ``crossover_hz``. The sub band passes through unmodified;
        the mid/upper band is sent through asymmetric saturation for harmonic
        density without muddying the low end.
        """
        sos_lp = signal.butter(
            2, crossover_hz, btype="lowpass", fs=self.sr, output="sos"
        )
        sos_hp = signal.butter(
            2, crossover_hz, btype="highpass", fs=self.sr, output="sos"
        )
        sub_band = signal.sosfilt(sos_lp, audio)
        mid_band = signal.sosfilt(sos_hp, audio)
        saturated_mid = self._asymmetric_saturate(
            mid_band, drive=drive, asymmetry=0.15
        )
        return sub_band + saturated_mid

    # ------------------------------------------------------------------ #
    # v3 psychoacoustic / dynamics / imaging modules                       #
    # ------------------------------------------------------------------ #

    def _harmonic_exciter(
        self,
        audio: np.ndarray,
        blend: float = 0.15,
        highpass_hz: float = 4500.0,
    ) -> np.ndarray:
        """Synthesise high-frequency harmonics to add brilliance and presence.

        Filters the band above *highpass_hz*, drives it through a nonlinear
        curve (tanh for odd harmonics + x² for even harmonics), then blends
        the new content back at *blend* ratio.  This generates energy that
        was not present in the original signal rather than simply boosting
        existing high-frequency content (which also lifts noise).
        """
        sos_hp = signal.butter(
            2, highpass_hz, btype="highpass", fs=self.sr, output="sos"
        )
        highs = signal.sosfilt(sos_hp, audio)
        excited = np.tanh(highs * 3.0) + 0.5 * (highs ** 2)
        # Re-highpass to remove any DC drift from the x² term
        excited_band = signal.sosfilt(sos_hp, excited)
        return audio + blend * excited_band

    def _midside_imaging(
        self,
        audio_stereo: np.ndarray,
        width: float = 1.1,
        mono_cutoff_hz: float = 140.0,
    ) -> np.ndarray:
        """Enforce mono low-end compatibility and control stereo width.

        Decomposes into Mid/Side, high-passes the Side channel to fold
        sub-bass below *mono_cutoff_hz* to pure mono (phase-cancellation-safe
        on club systems), then scales the remaining Side by *width* before
        reconstructing L/R.

        ``audio_stereo`` must be shape ``(samples, 2)`` (interleaved frames).
        Mono input is returned unchanged.
        """
        if audio_stereo.ndim != 2 or audio_stereo.shape[1] != 2:
            return audio_stereo

        L = audio_stereo[:, 0].astype(np.float64)
        R = audio_stereo[:, 1].astype(np.float64)

        M = (L + R) * 0.5
        S = (L - R) * 0.5

        sos_hp = signal.butter(
            2, mono_cutoff_hz, btype="highpass", fs=self.sr, output="sos"
        )
        S_out = signal.sosfilt(sos_hp, S) * float(width)

        L_out = (M + S_out).astype(np.float32)
        R_out = (M - S_out).astype(np.float32)
        return np.column_stack([L_out, R_out])

    def _vca_compress(
        self,
        audio: np.ndarray,
        threshold_db: float = -14.0,
        ratio: float = 3.0,
        attack_ms: float = 10.0,
        release_ms: float = 100.0,
    ) -> np.ndarray:
        """Feed-forward VCA compressor with smooth attack/release ballistics.

        Tracks the signal envelope with separate attack and release time
        constants, converts to dB, and applies gain reduction above the
        threshold — no hard clipping, so transient punch is preserved rather
        than sheared off.

        The sample loop operates on the *last* axis, so the method handles
        both mono ``(N,)`` and channels-first ``(C, N)`` arrays.
        """
        alpha_att = float(np.exp(-1.0 / (self.sr * attack_ms / 1000.0)))
        alpha_rel = float(np.exp(-1.0 / (self.sr * release_ms / 1000.0)))

        def _compress_1d(x: np.ndarray) -> np.ndarray:
            abs_x = np.abs(x.astype(np.float64)) + 1e-8
            env = np.empty_like(abs_x)
            curr = 0.0
            for i, v in enumerate(abs_x):
                if v > curr:
                    curr = alpha_att * curr + (1.0 - alpha_att) * v
                else:
                    curr = alpha_rel * curr + (1.0 - alpha_rel) * v
                env[i] = curr
            env_db = 20.0 * np.log10(env)
            over_db = env_db - threshold_db
            gr_db = np.where(over_db > 0.0, -over_db * (1.0 - 1.0 / ratio), 0.0)
            return (x * 10.0 ** (gr_db / 20.0)).astype(np.float32)

        if audio.ndim == 1:
            return _compress_1d(audio)
        # channels-first: compress each channel independently
        return np.stack([_compress_1d(audio[c]) for c in range(audio.shape[0])])

    def _cab_sim_eq(self, audio: np.ndarray) -> np.ndarray:
        """Replicate the frequency response of a 4×12 guitar cabinet.

        Stages:
        * +3.5 dB @ 85 Hz  Q 1.8  — speaker thump / low-end authority
        * −2.5 dB @ 500 Hz Q 1.0  — mid scoop / "open" cab character
        * +4.0 dB @ 3.8 kHz Q 1.4 — cone bite / pick attack presence
        * 3rd-order LP @ 5.5 kHz  — air-movement high-frequency roll-off
        """
        b_thump, a_thump = self._biquad_peaking(gain_db=3.5, freq_hz=85, q=1.8)
        b_scoop, a_scoop = self._biquad_peaking(gain_db=-2.5, freq_hz=500, q=1.0)
        b_bite, a_bite = self._biquad_peaking(gain_db=4.0, freq_hz=3800, q=1.4)
        sos_lp = signal.butter(3, 5500, btype="lowpass", fs=self.sr, output="sos")

        out = signal.lfilter(b_thump, a_thump, audio, axis=-1)
        out = signal.lfilter(b_scoop, a_scoop, out, axis=-1)
        out = signal.lfilter(b_bite, a_bite, out, axis=-1)
        return signal.sosfilt(sos_lp, out)

    # ------------------------------------------------------------------ #
    # Static utilities                                                     #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _normalize_ceiling(audio: np.ndarray, ceiling: float = 0.965) -> np.ndarray:
        max_val = float(np.max(np.abs(audio)))
        if max_val > ceiling:
            return audio * (ceiling / max_val)
        return audio

    # ------------------------------------------------------------------ #
    # Bus routing matrix                                                   #
    # ------------------------------------------------------------------ #

    def process_bus(
        self, audio: np.ndarray, bus_type: str, intensity: float = 0.5
    ) -> np.ndarray:
        """Route audio through a calibrated bus chain.

        Parameters
        ----------
        audio:
            Mono ``(samples,)`` or channels-first ``(channels, samples)``.
        bus_type:
            One of ``acoustic``, ``voice``, ``electric``, ``beats``, ``bass``.
        intensity:
            Shaping depth, clamped to ``[0.0, 1.0]``.
        """
        intensity = float(np.clip(intensity, 0.0, 1.0))
        out = np.asarray(audio, dtype=np.float32).copy()

        if bus_type == "acoustic":
            b_notch, a_notch = self._biquad_peaking(
                gain_db=-4.5 * intensity, freq_hz=250, q=2.0
            )
            b_pick, a_pick = self._biquad_peaking(
                gain_db=3.0 * intensity, freq_hz=3200, q=1.2
            )
            b_air, a_air = self._biquad_shelf(
                gain_db=4.0 * intensity, freq_hz=12000, shelf_type="high"
            )
            out = signal.lfilter(b_notch, a_notch, out, axis=-1)
            out = signal.lfilter(b_pick, a_pick, out, axis=-1)
            out = signal.lfilter(b_air, a_air, out, axis=-1)
            # Synthesise new upper air above 5 kHz (ReHance-style)
            out = self._harmonic_exciter(out, blend=0.10 * intensity, highpass_hz=5000.0)

        elif bus_type == "voice":
            b_pres, a_pres = self._biquad_peaking(
                gain_db=3.5 * intensity, freq_hz=3500, q=1.0
            )
            b_air, a_air = self._biquad_shelf(
                gain_db=4.5 * intensity, freq_hz=8000, shelf_type="high"
            )
            out = signal.lfilter(b_pres, a_pres, out, axis=-1)
            out = signal.lfilter(b_air, a_air, out, axis=-1)
            # Dynamic de-esser: threshold loosens slightly at lower intensities
            out = self._dynamic_deess(
                out,
                threshold_db=-18.0 + 5.0 * (1.0 - intensity),
                max_cut_db=6.0,
            )
            # Harmonic exciter: synthesise new upper-air content (ReHance-style)
            out = self._harmonic_exciter(out, blend=0.10 * intensity, highpass_hz=4500.0)
            out = self._asymmetric_saturate(
                out, drive=1.0 + 0.45 * intensity, asymmetry=0.12
            )

        elif bus_type == "electric":
            # 4×12 cab sim first (shapes the tone), then tube drive into it
            out = self._cab_sim_eq(out)
            out = self._asymmetric_saturate(
                out, drive=1.0 + 2.2 * intensity, asymmetry=0.25
            )

        elif bus_type == "beats":
            b_sub, a_sub = self._biquad_peaking(
                gain_db=3.0 * intensity, freq_hz=60, q=1.8
            )
            b_box, a_box = self._biquad_peaking(
                gain_db=-3.0 * intensity, freq_hz=200, q=2.0
            )
            b_snap, a_snap = self._biquad_peaking(
                gain_db=2.5 * intensity, freq_hz=4500, q=1.0
            )
            out = signal.lfilter(b_sub, a_sub, out, axis=-1)
            out = signal.lfilter(b_box, a_box, out, axis=-1)
            out = signal.lfilter(b_snap, a_snap, out, axis=-1)
            # VCA compressor for transient punch before saturation
            out = self._vca_compress(
                out,
                threshold_db=-14.0 - 4.0 * (1.0 - intensity),
                ratio=2.5 + 1.0 * intensity,
                attack_ms=8.0,
                release_ms=80.0,
            )
            out = self._asymmetric_saturate(
                out, drive=1.0 + 0.8 * intensity, asymmetry=0.10
            )

        elif bus_type == "bass":
            b_sub, a_sub = self._biquad_shelf(
                gain_db=3.5 * intensity, freq_hz=70, shelf_type="low"
            )
            b_growl, a_growl = self._biquad_peaking(
                gain_db=2.5 * intensity, freq_hz=750, q=1.4
            )
            out = signal.lfilter(b_sub, a_sub, out, axis=-1)
            out = signal.lfilter(b_growl, a_growl, out, axis=-1)
            # Dual-band crossover: clean sub + driven upper bass
            out = self._dual_band_bass_split(
                out,
                crossover_hz=120.0,
                drive=1.0 + 1.4 * intensity,
            )

        else:
            raise ValueError(f"Unknown bus_type: {bus_type}")

        out = self._normalize_ceiling(out)
        return out.astype(np.float32)
