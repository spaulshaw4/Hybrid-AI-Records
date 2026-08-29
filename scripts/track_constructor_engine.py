# D:\MusicDatasets\scripts\track_constructor_engine.py
"""
===============================================================================
HYBRID 1.0 - BINARY COMPOSITE TRACK CONSTRUCTOR
===============================================================================
Renders a JSON arrangement recipe onto an integer-frame canvas.

This is the structured counterpart to cylinder_bus_summation: that engine
concatenates one slice per timeline position, whereas this one places slices at
declared bar/beat positions with gain and pan, so several can overlap and a real
arrangement (intro / verse / chorus) can be expressed.

Alignment is locked to 64-bit integer sample frames. Frames-per-beat is computed
once and multiplied, rather than converting each event's time to seconds and back
to samples - repeated float conversion accumulates rounding drift across a long
arrangement, which is audible as timing smear by the final bars.

The Q4 master chain comes from hybrid_dsp rather than being reimplemented here,
so a limiter or dither change lands in one place for every engine.
"""

import os
import sys
import json
import wave
import hashlib
import tempfile
import argparse
import numpy as np

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from hybrid_dsp import (
    read_wav_float32,
    write_wav_float32,
    apply_dc_blocker,
    apply_soft_knee_limiter,
    dbfs_to_linear,
    linear_to_dbfs,
)

SAMPLE_RATE = 44100
STORAGE_BUCKET = "vault-storage"
ZERO_CROSS_SEARCH = 64

DEFAULT_THRESHOLD_DBFS = -3.0
DEFAULT_CEILING_DBFS = -0.5


class BinaryCompositeConstructor:
    def __init__(self, recipe: dict, slices_dir: str, sample_rate: int = SAMPLE_RATE):
        self.recipe = recipe
        self.slices_dir = slices_dir
        self.sample_rate = int(recipe.get("sample_rate", sample_rate))

        self.bpm = float(recipe.get("bpm", 120.0))
        if self.bpm <= 0:
            raise ValueError(f"bpm must be positive, got {self.bpm}")

        ts = recipe.get("time_signature", [4, 4])
        self.ts_num = int(ts[0]) if isinstance(ts, (list, tuple)) and ts else 4

        # Integer frame grid, established once
        self.samples_per_beat = int(np.round((60.0 / self.bpm) * self.sample_rate))
        self.samples_per_bar = self.samples_per_beat * self.ts_num

        self.bit_depth = int(recipe.get("bit_depth", 16))
        if self.bit_depth not in (16, 24):
            self.bit_depth = 16

        # Prefer an explicit duration; otherwise derive it from the bar count so
        # a recipe cannot silently truncate its own final section.
        declared = recipe.get("total_duration_sec")
        total_bars = recipe.get("total_bars")

        if declared:
            self.total_duration_sec = float(declared)
        elif total_bars:
            self.total_duration_sec = (int(total_bars) * self.samples_per_bar) / self.sample_rate
        else:
            self.total_duration_sec = 120.0

        self.total_frames = int(round(self.sample_rate * self.total_duration_sec))
        if self.total_frames <= 0:
            raise ValueError("Arrangement resolves to zero frames.")

        self.master_canvas = np.zeros((self.total_frames, 2), dtype=np.float32)
        self.placed = 0
        self.truncated = 0
        self.skipped = []

    def bar_beat_to_frame(self, bar: int, beat: float) -> int:
        return int((int(bar) - 1) * self.samples_per_bar +
                   int(round((float(beat) - 1.0) * self.samples_per_beat)))

    def validate_recipe(self):
        """
        Check every referenced slice exists before rendering anything.

        Without this, a typo in the last arrangement entry is only discovered
        after the whole canvas has been built.
        """
        items = self.recipe.get("arrangement", [])
        if not items:
            raise ValueError("Recipe contains no arrangement entries.")

        missing = []
        for idx, item in enumerate(items):
            fname = item.get("slice_file")
            if not fname:
                missing.append(f"entry {idx}: no slice_file")
            elif not os.path.exists(os.path.join(self.slices_dir, fname)):
                missing.append(f"entry {idx}: {fname}")

        if missing:
            raise FileNotFoundError(
                "Recipe references slices that are not present in "
                f"{self.slices_dir}:\n  " + "\n  ".join(missing)
            )

        return len(items)

    def load_slice(self, filename: str) -> np.ndarray:
        data, sr = read_wav_float32(os.path.join(self.slices_dir, filename))

        if sr != self.sample_rate:
            # Placing a differently-rated slice on the grid would shift its
            # pitch and length, so this is refused rather than silently mixed.
            raise ValueError(
                f"{filename} is {sr} Hz but the arrangement grid is "
                f"{self.sample_rate} Hz. Resample it before placing."
            )

        # Copy so the pan/gain multiply below never writes into a read-only
        # buffer, and so a slice reused by two entries is not doubly scaled.
        return apply_dc_blocker(data).copy()

    def snap_to_zero_crossing(self, audio: np.ndarray) -> np.ndarray:
        """Shift the head to the first sign change within the search window."""
        window = audio[:ZERO_CROSS_SEARCH]
        if len(window) < 2:
            return audio

        mono = np.mean(window, axis=1)
        signs = np.signbit(mono)
        crossings = np.nonzero(signs[:-1] != signs[1:])[0]

        return audio[int(crossings[0]) + 1:] if len(crossings) else audio

    def construct(self, threshold_dbfs=DEFAULT_THRESHOLD_DBFS,
                  ceiling_dbfs=DEFAULT_CEILING_DBFS, enable_dither=True,
                  oversample=1) -> np.ndarray:
        items = self.recipe.get("arrangement", [])

        print(f"[CONSTRUCT] {len(items)} arrangement block(s) at {self.bpm} BPM "
              f"{self.ts_num}/4")
        print(f"[CONSTRUCT] Grid: {self.samples_per_beat} frames/beat, "
              f"{self.samples_per_bar} frames/bar")
        print(f"[CONSTRUCT] Canvas: {self.total_frames} frames "
              f"({self.total_duration_sec:.2f}s)")

        for idx, item in enumerate(items):
            bar = item.get("bar", 1)
            beat = item.get("beat", 1.0)
            start_frame = self.bar_beat_to_frame(bar, beat)

            if start_frame >= self.total_frames:
                self.skipped.append(
                    f"entry {idx} ({item.get('slice_file')}) at bar {bar} beat {beat} "
                    f"starts past the {self.total_duration_sec:.2f}s canvas"
                )
                continue

            audio = self.snap_to_zero_crossing(self.load_slice(item["slice_file"]))

            # Constant-power pan: pan 0 puts -3 dB in each channel, so total
            # power is preserved as the source moves across the field.
            pan = float(np.clip(item.get("pan", 0.0), -1.0, 1.0))
            pan_rad = (pan + 1.0) * (np.pi / 4.0)
            gain = float(item.get("gain_linear", 1.0))

            audio[:, 0] *= gain * np.cos(pan_rad)
            audio[:, 1] *= gain * np.sin(pan_rad)

            end_frame = min(start_frame + len(audio), self.total_frames)
            valid_len = end_frame - start_frame

            if valid_len < len(audio):
                self.truncated += 1

            if valid_len > 0:
                self.master_canvas[start_frame:end_frame] += audio[:valid_len]
                self.placed += 1

        print(f"[CONSTRUCT] Placed {self.placed}/{len(items)} blocks "
              f"({self.truncated} truncated at canvas end)")

        for note in self.skipped:
            print(f"  [SKIPPED] {note}")

        pre_peak = float(np.max(np.abs(self.master_canvas)))
        print(f"[CONSTRUCT] Pre-limiter peak: {linear_to_dbfs(pre_peak):.2f} dBFS")

        if oversample > 1:
            print(f"[CONSTRUCT] Limiting at {oversample}x to suppress tanh aliasing "
                  f"(adds roughly 10s to a 7-minute canvas)")

        limited = apply_soft_knee_limiter(
            self.master_canvas,
            threshold_linear=dbfs_to_linear(threshold_dbfs),
            ceiling_linear=dbfs_to_linear(ceiling_dbfs),
            oversample=oversample
        )

        post_peak = float(np.max(np.abs(limited)))
        print(f"[CONSTRUCT] Post-limiter peak: {linear_to_dbfs(post_peak):.2f} dBFS "
              f"(ceiling {ceiling_dbfs} dBFS)")

        self._enable_dither = enable_dither
        return limited

    def render_to_file(self, output_path: str, **kwargs) -> dict:
        self.validate_recipe()
        rendered = self.construct(**kwargs)

        write_wav_float32(output_path, rendered, self.sample_rate,
                          target_bit_depth=self.bit_depth,
                          enable_dither=getattr(self, "_enable_dither", True))

        hasher = hashlib.sha256()
        with open(output_path, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)

        return {
            "output_path": output_path,
            "master_hash": hasher.hexdigest(),
            "size_bytes": os.path.getsize(output_path),
            "duration_sec": round(self.total_duration_sec, 2),
            "sample_rate": self.sample_rate,
            "bit_depth": self.bit_depth,
            "bpm": self.bpm,
            "blocks_placed": self.placed,
            "blocks_truncated": self.truncated,
            "blocks_skipped": len(self.skipped),
            "track_title": self.recipe.get("track_title", "untitled")
        }

    def export_and_upload(self, session_id: str, user_id: str, keep_local=None):
        """
        Render, then push to the Vault.

        The scratchpad is a temp dir so nothing accumulates locally, matching the
        Tier 1 zero-disk-accumulation requirement. Pass keep_local to retain a
        copy for listening.
        """
        from supabase import create_client, Client

        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

        with tempfile.TemporaryDirectory(prefix=f"hybrid_{session_id}_") as tmpdir:
            local_wav = os.path.join(tmpdir, "master_output.wav")
            result = self.render_to_file(local_wav)

            if keep_local:
                os.makedirs(os.path.dirname(os.path.abspath(keep_local)), exist_ok=True)
                import shutil
                shutil.copyfile(local_wav, keep_local)
                print(f"[LOCAL COPY] {keep_local}")

            if not (url and key):
                print("[LOCAL EXPORT] Supabase credentials not set; skipping upload.")
                return result

            sb: Client = create_client(url, key)
            remote_path = f"masters/{session_id}/master_output.wav"

            with open(local_wav, "rb") as f:
                sb.storage.from_(STORAGE_BUCKET).upload(
                    path=remote_path,
                    file=f,
                    file_options={"content-type": "audio/wav", "x-upsert": "true"}
                )

            from datetime import datetime, timezone

            # Merge rather than replace: a session queued through the normal flow
            # already carries token cost and trigger source in metadata.
            existing = sb.table("user_vaults").select("metadata").eq(
                "session_id", session_id).limit(1).execute()
            merged = dict(existing.data[0]["metadata"]) if (
                existing.data and existing.data[0].get("metadata")) else {}

            merged.update({
                "track_title": result["track_title"],
                "bpm": result["bpm"],
                "duration_sec": result["duration_sec"],
                "size_bytes": result["size_bytes"],
                "blocks_placed": result["blocks_placed"],
                "render_engine": "binary_composite_constructor",
                "storage_bucket": STORAGE_BUCKET,
                "storage_path": remote_path
            })

            sb.table("user_vaults").upsert({
                "session_id": session_id,
                "user_id": user_id,
                "status": "completed",
                "master_hash": result["master_hash"],
                "storage_url": remote_path,
                "metadata": merged,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }, on_conflict="session_id").execute()

            print(f"[SUCCESS] Master in Vault: {remote_path}")
            print(f"          SHA-256: {result['master_hash']}")
            result["storage_url"] = remote_path

        print("[CLEANUP] Scratchpad purged.")
        return result


def main():
    parser = argparse.ArgumentParser(description="Hybrid 1.0 binary composite track constructor")
    parser.add_argument("recipe", help="Path to the arrangement recipe JSON")
    parser.add_argument("slices_dir", help="Directory holding the referenced slices")
    parser.add_argument("session_id", nargs="?", default=None,
                        help="Session ID. Omit to render locally without touching Supabase.")
    parser.add_argument("--user-id", default="00000000-0000-0000-0000-000000000001")
    parser.add_argument("--output", default=None, help="Render here instead of uploading")
    parser.add_argument("--keep-local", default=None, help="Also keep a local copy when uploading")
    parser.add_argument("--threshold-dbfs", type=float, default=DEFAULT_THRESHOLD_DBFS)
    parser.add_argument("--ceiling-dbfs", type=float, default=DEFAULT_CEILING_DBFS)
    parser.add_argument("--no-dither", action="store_true")
    parser.add_argument("--oversample", type=int, default=1, choices=[1, 2, 4, 8],
                        help="Run the Q4 limiter at this multiple to suppress tanh " +
                             "aliasing. 4x drops folded harmonics about 60 dB.")
    parser.add_argument("--validate-only", action="store_true",
                        help="Check the recipe and slice references, then exit")
    args = parser.parse_args()

    with open(args.recipe, "r", encoding="utf-8") as rf:
        recipe = json.load(rf)

    engine = BinaryCompositeConstructor(recipe, args.slices_dir)

    if args.validate_only:
        n = engine.validate_recipe()
        print(f"[VALIDATE] Recipe OK: {n} block(s), all slices present.")
        print(f"[VALIDATE] {engine.total_duration_sec:.2f}s canvas at {engine.bpm} BPM")
        return 0

    dsp = {
        "threshold_dbfs": args.threshold_dbfs,
        "ceiling_dbfs": args.ceiling_dbfs,
        "enable_dither": not args.no_dither,
        "oversample": args.oversample
    }

    if args.output or not args.session_id:
        out = args.output or os.path.join(os.getcwd(), "master_output.wav")
        engine.validate_recipe()
        rendered = engine.construct(**dsp)
        write_wav_float32(out, rendered, engine.sample_rate,
                          target_bit_depth=engine.bit_depth,
                          enable_dither=not args.no_dither)
        print(f"[RENDERED] {out}")
    else:
        engine.export_and_upload(args.session_id, args.user_id, keep_local=args.keep_local)

    return 0


if __name__ == "__main__":
    sys.exit(main())
