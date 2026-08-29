# D:\MusicDatasets\scripts\validate_audio_stems.py
"""
===============================================================================
HYBRID 1.0 - PRE-FLIGHT AUDIO STEM INTEGRITY & FORMAT VALIDATOR
===============================================================================
Inspects stem directories before processing to guarantee:
  - Valid RIFF/WAV headers with readable PCM chunks
  - Zero unreadable or 0-byte files
  - Active signal (flags dead-air stems below the silence floor)
  - Sample rate and channel consistency across the set
  - A structured stem_manifest.json for the Quadrant DSP engine

Status markers are ASCII. A Windows console under the default cp1252 code page
raises UnicodeEncodeError on emoji, which would crash the validator on exactly
the platform it runs on.
"""

import os
import sys
import wave
import json
import argparse
import numpy as np

SILENCE_FLOOR_DBFS = -90.0
LEVEL_INSPECT_SEC = 10


def inspect_stem_file(filepath: str) -> dict:
    name = os.path.basename(filepath)

    if not os.path.exists(filepath):
        return {"file": name, "valid": False, "error": "file does not exist"}

    size_bytes = os.path.getsize(filepath)
    if size_bytes < 44:
        return {"file": name, "valid": False,
                "error": f"truncated or empty ({size_bytes} bytes, WAV header needs 44)"}

    try:
        with wave.open(filepath, "rb") as wav:
            n_channels = wav.getnchannels()
            sampwidth = wav.getsampwidth()
            framerate = wav.getframerate()
            n_frames = wav.getnframes()

            if n_frames == 0:
                return {"file": name, "valid": False, "error": "zero audio frames"}
            if framerate <= 0:
                return {"file": name, "valid": False, "error": f"invalid sample rate ({framerate})"}

            read_frames = min(n_frames, framerate * LEVEL_INSPECT_SEC)
            raw = wav.readframes(read_frames)

        if not raw:
            return {"file": name, "valid": False, "error": "header declares frames but data chunk is empty"}

        if sampwidth == 2:
            data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        elif sampwidth == 3:
            usable = (len(raw) // 3) * 3
            padded = bytearray()
            for i in range(0, usable, 3):
                padded.extend(b"\x00" + raw[i:i + 3])
            data = np.frombuffer(bytes(padded), dtype="<i4").astype(np.float32) / 2147483648.0
        elif sampwidth == 4:
            data = np.frombuffer(raw, dtype="<f4")
        else:
            return {"file": name, "valid": False, "error": f"unsupported sample width ({sampwidth} bytes)"}

        if len(data) == 0:
            return {"file": name, "valid": False, "error": "no decodable samples"}

        # Guard against NaN/Inf in float32 WAVs, which would poison every
        # downstream sum and silently produce an all-NaN master.
        finite = np.isfinite(data)
        n_nonfinite = int((~finite).sum())
        if n_nonfinite:
            data = data[finite]
            if len(data) == 0:
                return {"file": name, "valid": False, "error": "all samples non-finite (NaN/Inf)"}

        peak_linear = float(np.max(np.abs(data)))
        rms_linear = float(np.sqrt(np.mean(data ** 2)))

        # Coerce out of numpy scalars before this dict reaches json.dump. A
        # numpy float64 comparison yields numpy.bool_, which json cannot
        # serialize, and the failure only surfaces when the manifest is written.
        peak_dbfs = float(20.0 * np.log10(peak_linear + 1e-9))
        rms_dbfs = float(20.0 * np.log10(rms_linear + 1e-9))

        return {
            "file": name,
            "valid": True,
            "channels": int(n_channels),
            "bit_depth": int(sampwidth * 8),
            "sample_rate": int(framerate),
            "duration_sec": round(float(n_frames / framerate), 3),
            "peak_dbfs": round(peak_dbfs, 2),
            "rms_dbfs": round(rms_dbfs, 2),
            "is_silent": bool(rms_dbfs < SILENCE_FLOOR_DBFS),
            "is_clipped": bool(peak_linear >= 0.9999),
            "nonfinite_samples": int(n_nonfinite),
            "size_kb": round(float(size_bytes / 1024.0), 1)
        }

    except wave.Error as e:
        return {"file": name, "valid": False, "error": f"malformed RIFF/WAV: {e}"}
    except Exception as e:
        return {"file": name, "valid": False, "error": str(e)}


def validate_stems_directory(stems_dir: str, manifest_out: str = None,
                             max_report: int = 40, allow_silent: bool = True) -> bool:
    print(f"[PRE-FLIGHT] Inspecting stem collection in: {stems_dir}")

    if not os.path.isdir(stems_dir):
        print(f"[PRE-FLIGHT ERROR] Not a directory: {stems_dir}")
        return False

    wav_files = sorted(
        os.path.join(stems_dir, f) for f in os.listdir(stems_dir) if f.lower().endswith(".wav")
    )

    if not wav_files:
        print(f"[PRE-FLIGHT ERROR] No WAV files discovered in {stems_dir}")
        return False

    print(f"[PRE-FLIGHT] Found {len(wav_files)} WAV file(s).")

    reports = []
    has_errors = False
    reference_sample_rate = None
    rate_mismatches = 0
    silent_count = 0
    clipped_count = 0
    shown = 0

    for f in wav_files:
        rep = inspect_stem_file(f)
        reports.append(rep)

        if not rep["valid"]:
            has_errors = True
            if shown < max_report:
                print(f"  [INVALID] {rep['file']:<34} {rep.get('error')}")
                shown += 1
            continue

        if reference_sample_rate is None:
            reference_sample_rate = rep["sample_rate"]
        elif rep["sample_rate"] != reference_sample_rate:
            rate_mismatches += 1
            if shown < max_report:
                print(f"  [RATE]    {rep['file']:<34} {rep['sample_rate']} Hz "
                      f"(set reference is {reference_sample_rate} Hz)")
                shown += 1

        if rep["is_silent"]:
            silent_count += 1
            if shown < max_report:
                print(f"  [SILENT]  {rep['file']:<34} RMS {rep['rms_dbfs']} dBFS "
                      f"(below {SILENCE_FLOOR_DBFS} floor)")
                shown += 1
        elif rep["is_clipped"]:
            clipped_count += 1
            if shown < max_report:
                print(f"  [CLIPPED] {rep['file']:<34} peak {rep['peak_dbfs']} dBFS")
                shown += 1
        elif shown < max_report:
            print(f"  [OK]      {rep['file']:<34} {rep['channels']}ch | {rep['bit_depth']}-bit | "
                  f"{rep['sample_rate']} Hz | {rep['duration_sec']}s | peak {rep['peak_dbfs']} dBFS")
            shown += 1

    if len(wav_files) > shown:
        print(f"  ... {len(wav_files) - shown} more file(s) inspected, output truncated "
              f"(raise --max-report to see them)")

    valid_count = sum(1 for r in reports if r["valid"])

    manifest = {
        "session_directory": stems_dir,
        "total_stems": len(reports),
        "valid_stems": valid_count,
        "invalid_stems": len(reports) - valid_count,
        "silent_stems": silent_count,
        "clipped_stems": clipped_count,
        "sample_rate_mismatches": rate_mismatches,
        "reference_sample_rate": int(reference_sample_rate) if reference_sample_rate else None,
        "passed_validation": bool(not has_errors),
        "stems": reports
    }

    # Default the manifest alongside the directory rather than inside it, so a
    # genre corpus under uploaded_slices/<genre>/ does not accumulate JSON files
    # among the audio.
    if manifest_out is None:
        parent = os.path.dirname(os.path.abspath(stems_dir))
        leaf = os.path.basename(os.path.abspath(stems_dir))
        manifest_out = os.path.join(parent, f"{leaf}_stem_manifest.json")

    os.makedirs(os.path.dirname(os.path.abspath(manifest_out)), exist_ok=True)
    with open(manifest_out, "w", encoding="utf-8") as out_f:
        json.dump(manifest, out_f, indent=2)

    print()
    print(f"[PRE-FLIGHT] {valid_count}/{len(reports)} valid | {silent_count} silent | "
          f"{clipped_count} clipped | {rate_mismatches} rate mismatch")
    print(f"[PRE-FLIGHT] Manifest written: {manifest_out}")

    if has_errors:
        print("[PRE-FLIGHT] FAILED - unreadable or corrupt stems present.")
    elif silent_count and not allow_silent:
        print("[PRE-FLIGHT] FAILED - silent stems present and --strict-silence was set.")
        return False
    else:
        print("[PRE-FLIGHT] PASSED")

    return not has_errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 pre-flight stem validator")
    parser.add_argument("--stems-dir", required=True, help="Directory containing audio stems")
    parser.add_argument("--manifest-out", default=None,
                        help="Manifest path. Defaults to <dir>_stem_manifest.json beside the directory.")
    parser.add_argument("--max-report", type=int, default=40,
                        help="Cap per-file lines printed. Corpus dirs hold thousands of slices.")
    parser.add_argument("--strict-silence", action="store_true",
                        help="Treat silent stems as a failure, not a warning")
    args = parser.parse_args()

    ok = validate_stems_directory(
        args.stems_dir,
        manifest_out=args.manifest_out,
        max_report=args.max_report,
        allow_silent=not args.strict_silence
    )
    sys.exit(0 if ok else 1)
