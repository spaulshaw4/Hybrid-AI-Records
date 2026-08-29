# D:\MusicDatasets\scripts\test_genre_quadrants_suite.py
"""
===============================================================================
HYBRID 1.0 - 5-GENRE 4-QUADRANT DSP CALIBRATION & VERIFICATION SUITE
===============================================================================
Synthesizes dedicated multi-track stems across Q1 (Foundation), Q2 (Harmonics),
and Q3 (Leads/Tops), then executes the 4-Quadrant DSP Matrix across all 5 genre
presets, validating peak headroom compliance against each profile's ceiling.

Stems are named with role keywords, so this exercises filename-based routing.
The spectral-centroid fallback is covered separately by --spectral, which strips
the keywords to confirm unlabelled material still lands in the right quadrant.
"""

import os
import sys
import time
import wave
import argparse
import tempfile
import shutil
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from genre_quadrant_engine import execute_genre_quadrants, GENRE_PROFILES, classify_stem

SAMPLE_RATE = 44100
DURATION_SEC = 4.0

GENRES = [
    "heavy_alternative_rock",
    "nu_metal",
    "rap_rock",
    "amapiano",
    "reggae"
]


def synthesize_wav(filepath: str, audio_data: np.ndarray, sample_rate: int = SAMPLE_RATE):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    quantized = np.clip(audio_data * 32767.0, -32768.0, 32767.0).astype(np.int16)
    with wave.open(filepath, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(quantized.tobytes())


def generate_q1_foundation_stems(target_dir: str, prefix: str):
    """55 Hz sub-bass plus a pitch-swept kick at 120 BPM."""
    t = np.linspace(0, DURATION_SEC, int(SAMPLE_RATE * DURATION_SEC), endpoint=False)

    sub = 0.65 * np.sin(2 * np.pi * 55.0 * t) + 0.15 * np.sin(2 * np.pi * 110.0 * t)
    synthesize_wav(os.path.join(target_dir, f"{prefix}sub_bass_55hz.wav"),
                   np.column_stack((sub, sub)))

    kick = np.zeros(len(t), dtype=np.float32)
    beat_interval = int(SAMPLE_RATE * 0.5)
    for start in range(0, len(t) - int(SAMPLE_RATE * 0.25), beat_interval):
        hit_len = int(SAMPLE_RATE * 0.25)
        hit_t = np.linspace(0, 0.25, hit_len, endpoint=False)
        freq_sweep = 150.0 * np.exp(-hit_t * 18.0) + 45.0
        env = np.exp(-hit_t * 12.0)
        kick[start:start + hit_len] += 0.85 * np.sin(2 * np.pi * freq_sweep * hit_t) * env

    synthesize_wav(os.path.join(target_dir, f"{prefix}kick_low.wav"),
                   np.column_stack((kick, kick)))


def generate_q2_harmonic_stems(target_dir: str, prefix: str):
    """A-minor chord bed with a per-partial phase offset so M/S width is testable."""
    t = np.linspace(0, DURATION_SEC, int(SAMPLE_RATE * DURATION_SEC), endpoint=False)

    chord_l = (0.25 * np.sin(2 * np.pi * 220.00 * t) +
               0.20 * np.sin(2 * np.pi * 261.63 * t) +
               0.20 * np.sin(2 * np.pi * 329.63 * t))
    chord_r = (0.25 * np.sin(2 * np.pi * 220.00 * t + 0.5) +
               0.20 * np.sin(2 * np.pi * 261.63 * t + 1.0) +
               0.20 * np.sin(2 * np.pi * 329.63 * t + 1.5))

    chord_stereo = np.tanh(np.column_stack((chord_l, chord_r)) * 1.5) * 0.7
    synthesize_wav(os.path.join(target_dir, f"{prefix}rhythm_guitars_keys.wav"), chord_stereo)


def generate_q3_lead_stems(target_dir: str, prefix: str):
    """Vibrato lead tone plus filtered noise bursts on the 2 and 4."""
    t = np.linspace(0, DURATION_SEC, int(SAMPLE_RATE * DURATION_SEC), endpoint=False)

    vibrato = 5.0 * np.sin(2 * np.pi * 5.0 * t)
    vox = 0.55 * np.sin(2 * np.pi * (440.0 + vibrato) * t) + 0.25 * np.sin(2 * np.pi * 880.0 * t)
    synthesize_wav(os.path.join(target_dir, f"{prefix}lead_vocal_vox.wav"),
                   np.column_stack((vox, vox)))

    snare = np.zeros(len(t), dtype=np.float32)
    noise = np.random.uniform(-1.0, 1.0, len(t))
    beat_interval = int(SAMPLE_RATE * 1.0)
    for start in range(int(SAMPLE_RATE * 0.5), len(t) - int(SAMPLE_RATE * 0.2), beat_interval):
        hit_len = int(SAMPLE_RATE * 0.18)
        hit_t = np.linspace(0, 0.18, hit_len, endpoint=False)
        env = np.exp(-hit_t * 22.0)
        snare[start:start + hit_len] += noise[start:start + hit_len] * env * 0.6

    synthesize_wav(os.path.join(target_dir, f"{prefix}snare_cymbal_hat.wav"),
                   np.column_stack((snare, snare)))


def analyze_audio_master(filepath: str) -> dict:
    with wave.open(filepath, "rb") as wav:
        n_ch = wav.getnchannels()
        sw = wav.getsampwidth()
        fr = wav.getframerate()
        nf = wav.getnframes()
        raw = wav.readframes(nf)

    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 3:
        padded = bytearray()
        for i in range(0, len(raw), 3):
            padded.extend(b"\x00" + raw[i:i + 3])
        data = np.frombuffer(bytes(padded), dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        data = np.frombuffer(raw, dtype=np.float32)

    data = data.reshape(-1, n_ch)

    peak_linear = float(np.max(np.abs(data)))
    rms_linear = float(np.sqrt(np.mean(data ** 2)))

    # Correlation between channels: 1.0 means fully mono, lower means real width
    if n_ch == 2 and np.std(data[:, 0]) > 1e-9 and np.std(data[:, 1]) > 1e-9:
        correlation = float(np.corrcoef(data[:, 0], data[:, 1])[0, 1])
    else:
        correlation = 1.0

    return {
        "channels": n_ch,
        "sample_rate": fr,
        "bit_depth": sw * 8,
        "duration_sec": round(len(data) / fr, 2),
        "peak_dbfs": round(20.0 * np.log10(peak_linear + 1e-9), 2),
        "rms_dbfs": round(20.0 * np.log10(rms_linear + 1e-9), 2),
        "correlation": round(correlation, 3),
        "size_kb": round(os.path.getsize(filepath) / 1024.0, 1),
        "is_clipped": peak_linear > 0.9999
    }


def verify_spectral_routing(base_dir: str):
    """
    Confirm the centroid fallback routes unlabelled stems correctly.

    This is the path that actually runs on this corpus, since slices are named
    slice_<genre>_<ts>_<n>.wav and carry no role information.
    """
    print("\n[SPECTRAL FALLBACK] Re-routing the same stems with role keywords stripped...")

    neutral_dir = os.path.join(base_dir, "neutral_stems")
    os.makedirs(neutral_dir, exist_ok=True)

    generate_q1_foundation_stems(neutral_dir, "a_")
    generate_q2_harmonic_stems(neutral_dir, "b_")
    generate_q3_lead_stems(neutral_dir, "c_")

    # Expected quadrant when only spectral content is available.
    #
    # The vocal is deliberately 2, not 3. Its fundamental is 440 Hz with an 880 Hz
    # partial, which is mid-band by any spectral measure - no energy-based
    # classifier can recover "this is a lead vocal" from that. Q3 membership for
    # vocals is a role judgement, which is exactly why the filename keyword path
    # exists and takes precedence. Asserting 3 here would be asserting a
    # capability the spectral fallback cannot have.
    expected = {
        "a_sub_bass_55hz.wav": 1,
        "a_kick_low.wav": 1,
        "b_rhythm_guitars_keys.wav": 2,
        "c_lead_vocal_vox.wav": 2,
        "c_snare_cymbal_hat.wav": 3,
    }

    from hybrid_dsp import read_wav_float32

    passes = 0
    for fname, want in expected.items():
        path = os.path.join(neutral_dir, fname)
        data, sr = read_wav_float32(path)

        # Strip the keywords so only the spectral path can decide
        anonymous = "slice_000.wav"
        got = classify_stem(anonymous, data, sr)

        ok = got == want
        passes += int(ok)
        print(f"  {'OK  ' if ok else 'MISS'} {fname:<32} expected Q{want}, spectral routed Q{got}")

    print(f"  Spectral routing accuracy: {passes}/{len(expected)}")
    return passes, len(expected)


def run_suite(base_dir: str, check_spectral: bool = True):
    print("================================================================")
    print("HYBRID 1.0 - 5-GENRE 4-QUADRANT DSP CALIBRATION SUITE")
    print(f"Sample Rate: {SAMPLE_RATE} Hz | Duration: {DURATION_SEC}s per test")
    print(f"Work dir   : {base_dir}")
    print("================================================================\n")

    stems_dir = os.path.join(base_dir, "synthetic_stems")
    os.makedirs(stems_dir, exist_ok=True)

    print("[STAGE 1/2] Synthesizing multi-quadrant acoustic stems...")
    generate_q1_foundation_stems(stems_dir, "stem_")
    print("  -> Q1: stem_sub_bass_55hz.wav, stem_kick_low.wav")
    generate_q2_harmonic_stems(stems_dir, "stem_")
    print("  -> Q2: stem_rhythm_guitars_keys.wav")
    generate_q3_lead_stems(stems_dir, "stem_")
    print("  -> Q3: stem_lead_vocal_vox.wav, stem_snare_cymbal_hat.wav")

    print("\n[STAGE 2/2] Processing the matrix across 5 genre profiles...\n")

    results = []
    for genre in GENRES:
        output_master = os.path.join(base_dir, genre, f"{genre}_master.wav")
        start_t = time.time()

        execute_genre_quadrants(
            stems_dir=stems_dir,
            genre=genre,
            output_path=output_master,
            bit_depth=16
        )

        elapsed_ms = round((time.time() - start_t) * 1000.0, 1)
        metrics = analyze_audio_master(output_master)

        target_ceil = GENRE_PROFILES[genre]["q4_ceiling_dbfs"]
        expected_width = GENRE_PROFILES[genre]["q2_stereo_width"]

        # Tolerance covers the ~1 LSB that TPDF dither adds after limiting
        within_ceiling = metrics["peak_dbfs"] <= (target_ceil + 0.1)
        passed = (not metrics["is_clipped"]) and within_ceiling

        results.append({
            "genre": genre,
            "peak": f"{metrics['peak_dbfs']} dBFS",
            "rms": f"{metrics['rms_dbfs']} dBFS",
            "ceiling": f"{target_ceil} dBFS",
            "corr": f"{metrics['correlation']}",
            "width": f"{expected_width:.2f}",
            "dur": f"{metrics['duration_sec']}s",
            "time": f"{elapsed_ms} ms",
            "status": "PASS" if passed else "FAIL"
        })
        print()

    print("=" * 108)
    print(" " * 34 + "4-QUADRANT VERIFICATION MATRIX")
    print("=" * 108)
    print(f"{'Genre Preset':<25}{'Ceiling':<11}{'Peak':<12}{'RMS':<12}{'L/R Corr':<10}{'Width':<8}{'Dur':<8}{'Speed':<11}{'Verdict'}")
    print("-" * 108)

    all_passed = True
    for r in results:
        if r["status"] != "PASS":
            all_passed = False
        print(f"{r['genre']:<25}{r['ceiling']:<11}{r['peak']:<12}{r['rms']:<12}"
              f"{r['corr']:<10}{r['width']:<8}{r['dur']:<8}{r['time']:<11}[{r['status']}]")

    print("=" * 108)

    spectral_ok = True
    if check_spectral:
        got, total = verify_spectral_routing(base_dir)
        spectral_ok = got == total

    print()
    if all_passed and spectral_ok:
        print("OVERALL VERDICT: [ALL PASS] 5 genre profiles within ceiling, 0 clipping, spectral routing exact.")
    elif all_passed:
        print("OVERALL VERDICT: [PARTIAL] Ceilings respected, but spectral routing missed at least one stem.")
    else:
        print("OVERALL VERDICT: [FAIL] Headroom or ceiling mismatch detected.")
    print("=" * 108)

    return all_passed and spectral_ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 4-Quadrant calibration suite")
    parser.add_argument("--work-dir", default=None,
                        help="Where to write stems and masters. Defaults to a temp dir that is cleaned up.")
    parser.add_argument("--keep", action="store_true", help="Keep rendered output for listening")
    parser.add_argument("--no-spectral", action="store_true", help="Skip the spectral routing check")
    args = parser.parse_args()

    ephemeral = args.work_dir is None
    work_dir = args.work_dir or tempfile.mkdtemp(prefix="quadrant_suite_")

    try:
        ok = run_suite(work_dir, check_spectral=not args.no_spectral)
    finally:
        if ephemeral and not args.keep:
            shutil.rmtree(work_dir, ignore_errors=True)
        elif args.keep:
            print(f"\nRendered masters retained at: {work_dir}")

    sys.exit(0 if ok else 1)
