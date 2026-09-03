"""Vocal processing CLI. Does not pretend torch.tanh is RVC inference.

If ``--model`` points at an existing .onnx/.pth AND a real runtime is importable
(onnxruntime, or an rvc package), that path is attempted and documented.

Otherwise this prints ``[FALLBACK] no RVC checkpoint or runtime`` and uses
``dsp.vocal_pitch_corrector.tune_vocal_buffer`` (pitch_key_aligner + presence EQ).
No downloads. torch/librosa are not required.
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import numpy as np
from scipy.signal import resample_poly

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.abspath(os.path.join(_HERE, ".."))
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from dsp.vocal_pitch_corrector import tune_vocal_buffer  # noqa: E402


def _is_empty(audio: np.ndarray) -> bool:
    return np.asarray(audio).size == 0


def _maybe_resample(audio: np.ndarray, sr: int, target_sr: int) -> tuple[np.ndarray, int]:
    if target_sr <= 0 or int(sr) == int(target_sr):
        return audio, int(sr)
    g = int(np.gcd(int(sr), int(target_sr)))
    up, down = int(target_sr) // g, int(sr) // g
    frames = np.asarray(audio, dtype=np.float64)
    if frames.ndim == 1:
        return resample_poly(frames, up, down), int(target_sr)
    cols = [resample_poly(frames[:, ch], up, down) for ch in range(frames.shape[1])]
    return np.column_stack(cols), int(target_sr)


def _try_rvc_onnx(audio: np.ndarray, sr: int, model_path: str, shift: float) -> np.ndarray | None:
    """Call ONNX Runtime only when a checkpoint exists and the runtime imports.

    This is a thin session.run hook, not a full RVC graph rewriter. If the model
    I/O does not match a single float audio tensor, we return None and fall back.
    """
    if not model_path or not os.path.isfile(model_path):
        return None
    ext = os.path.splitext(model_path)[1].lower()
    if ext not in {".onnx", ".pth", ".pt"}:
        return None
    if ext == ".onnx":
        try:
            import onnxruntime as ort  # type: ignore
        except ImportError:
            print("[FALLBACK] onnxruntime not importable")
            return None
        try:
            sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
            inp = sess.get_inputs()[0]
            mono = np.mean(np.asarray(audio, dtype=np.float32), axis=1) if np.asarray(audio).ndim > 1 else np.asarray(audio, dtype=np.float32)
            feeds = {inp.name: mono.reshape(1, -1)}
            out = sess.run(None, feeds)[0]
            print(f"[RVC] onnxruntime session: {os.path.basename(model_path)}")
            return np.asarray(out, dtype=np.float64).reshape(-1)
        except Exception as exc:  # noqa: BLE001
            print(f"[FALLBACK] ONNX session failed ({exc})")
            return None
    try:
        import rvc  # type: ignore  # noqa: F401
    except ImportError:
        print("[FALLBACK] .pth present but no RVC package imported")
        return None
    print("[FALLBACK] RVC package present but no supported infer API wired")
    return None


def process_vocal(
    audio: np.ndarray,
    sr: int,
    model: str | None = None,
    shift: float = 0.0,
    **_: Any,
) -> tuple[np.ndarray, str]:
    if _is_empty(audio):
        return audio, "passthrough"
    if model:
        inferred = _try_rvc_onnx(audio, int(sr), model, float(shift))
        if inferred is not None:
            return inferred, "onnx_rvc"
    print("[FALLBACK] no RVC checkpoint or runtime")
    tuned = tune_vocal_buffer(audio, sr=int(sr), shift=float(shift))
    return tuned, "fallback_pitch"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Vocal pipeline: real ONNX/RVC if available, else honest pitch fallback"
    )
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--model", default=None, help="Optional local .onnx/.pth (never downloaded)")
    parser.add_argument("--shift", type=float, default=0.0, help="Semitone shift in fallback / hint")
    args = parser.parse_args()
    if not os.path.isfile(args.input):
        raise FileNotFoundError(f"Vocal input missing: {args.input}")
    try:
        import soundfile as sf
    except ImportError:
        print("[ERROR] soundfile is required for CLI use", file=sys.stderr)
        return 1
    audio, sr = sf.read(args.input, always_2d=True)
    if audio.size == 0:
        out, mode = audio, "passthrough"
    else:
        out, mode = process_vocal(audio, int(sr), model=args.model, shift=args.shift)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    sf.write(args.output, out, int(sr), subtype="PCM_24")
    print(f"[VOCAL] mode={mode} wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
