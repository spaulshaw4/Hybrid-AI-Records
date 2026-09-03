from .dynamic_eq_processor import apply_dynamic_eq, apply_dynamic_master_eq
from .harmonic_exciter import apply_harmonic_exciter
from .loudness_meter import LoudnessReport, measure_loudness, measure_loudness_dict
from .micro_crossfader import apply_equal_power_crossfade, crossfade_sequence
from .midside_processor import apply_midside_stereo_sculpt
from .landr_vst_bridge import apply_landr_bus_with_fallback
from .native_audio_engine import NativeAudioEngine
from .phase_aligner import PhaseAlignResult, align_stem_group, align_to_reference
from .pitch_key_aligner import (
    NOTE_MAP,
    NOTE_NAMES,
    align_slice_to_target_key,
    calculate_semitone_shift,
    detect_slice_key,
    pitch_shift_slice,
    shortest_semitone_delta,
)
from .polarity_inverter_check import PolarityReport, check_polarity, recommend_invert
# qc_metric_validator also defines phase_correlation; the stereo_widener one is the
# established package-level export, so the QC variant is re-exported under a prefix.
from .qc_metric_validator import (
    band_energies,
    measure_qc,
    phase_correlation as qc_phase_correlation,
    rms_dbfs,
    sample_peak_dbfs,
    validate_file,
)
from .stem_sidechain_glue import apply_sidechain_glue
from .stereo_widener import apply_stereo_widener, apply_stereo_widener_report, phase_correlation
from .sub_harmonic_synth import apply_sub_harmonic_synth
from .tape_saturation import apply_tape_saturation
from .tempo_time_stretch import (
    clip_stretch_rate,
    estimate_slice_bpm,
    fold_bpm_octave,
    lock_slice_to_tempo,
    time_stretch_wsola,
)
from .tpdf_dither import apply_tpdf_dither
from .transient_shaper import apply_transient_shaper
from .true_peak_limiter import apply_true_peak_limiter, measure_true_peak_dbtp
from .vocal_pitch_corrector import (
    get_scale_notes,
    snap_frequency_to_scale,
    tune_vocal_buffer,
)
from .smart_transient_slicer import (
    find_nearest_zero_crossing,
    find_phrase_zero_crossing,
    slice_audio,
    slice_audio_file,
)

__all__ = [
    "LoudnessReport",
    "NOTE_MAP",
    "NOTE_NAMES",
    "PhaseAlignResult",
    "PolarityReport",
    "NativeAudioEngine",
    "apply_landr_bus_with_fallback",
    "align_slice_to_target_key",
    "calculate_semitone_shift",
    "clip_stretch_rate",
    "align_stem_group",
    "align_to_reference",
    "apply_dynamic_eq",
    "apply_dynamic_master_eq",
    "apply_equal_power_crossfade",
    "apply_harmonic_exciter",
    "apply_midside_stereo_sculpt",
    "apply_sidechain_glue",
    "apply_stereo_widener",
    "apply_stereo_widener_report",
    "apply_sub_harmonic_synth",
    "apply_tape_saturation",
    "apply_tpdf_dither",
    "apply_transient_shaper",
    "apply_true_peak_limiter",
    "band_energies",
    "check_polarity",
    "crossfade_sequence",
    "detect_slice_key",
    "estimate_slice_bpm",
    "find_nearest_zero_crossing",
    "find_phrase_zero_crossing",
    "fold_bpm_octave",
    "lock_slice_to_tempo",
    "measure_loudness",
    "measure_loudness_dict",
    "measure_qc",
    "measure_true_peak_dbtp",
    "phase_correlation",
    "pitch_shift_slice",
    "qc_phase_correlation",
    "recommend_invert",
    "rms_dbfs",
    "sample_peak_dbfs",
    "shortest_semitone_delta",
    "slice_audio",
    "slice_audio_file",
    "time_stretch_wsola",
    "tune_vocal_buffer",
    "validate_file",
    "get_scale_notes",
    "snap_frequency_to_scale",
]
