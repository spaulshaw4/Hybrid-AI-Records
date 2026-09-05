"""Live terminal UI: sounddevice / loopback / WAV -> LiveStreamRouter."""

from __future__ import annotations

import argparse
import os
import queue
import sys
import time

import numpy as np
import torch
import torchaudio

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.live_stream_router import LiveStreamRouter

BUSES = ["acoustic", "voice", "electric", "beats", "bass"]
BAR_WIDTH = 28


def _bar(value: float, width: int = BAR_WIDTH) -> str:
    filled = int(max(0.0, min(1.0, value)) * width)
    return "#" * filled + "." * (width - filled)


def _fmt_db(db: float) -> str:
    if not np.isfinite(db) or db <= -90:
        return "  -inf"
    return f"{db:6.1f}"


def render_frame(mode: str, linear: dict, dbs: dict, rms_db: float, device: str) -> str:
    lines = [
        "LIVE STEM ROUTER  |  4s window  |  "
        f"infer={device}  |  mode={mode}  |  rms={rms_db:6.1f} dB",
        "",
        f"{'BUS':<10} {'P(bus)':<32} {'lin':>6} {'send dB':>8}",
    ]
    for bus in BUSES:
        gain = float(linear.get(bus, 0.0))
        lines.append(
            f"{bus.upper():<10} [{_bar(gain)}] {gain:6.3f} {_fmt_db(float(dbs.get(bus, -96.0)))}"
        )
    lines.append("")
    lines.append("Ctrl+C to stop")
    return "\n".join(lines)


def _chunk_rms_db(chunk: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(chunk)) + 1e-12))
    return 20.0 * np.log10(rms)


def run_wav_monitor(router: LiveStreamRouter, wav_path: str, hop_sec: float) -> None:
    waveform, sr = torchaudio.load(wav_path)
    chunk = waveform.mean(dim=0).numpy().astype(np.float32)
    if int(sr) != router.sample_rate:
        chunk = torchaudio.functional.resample(
            torch.from_numpy(chunk), int(sr), router.sample_rate
        ).numpy()
    hop = max(256, int(router.sample_rate * hop_sec))
    print(f"[LIVE] WAV monitor {wav_path} ({len(chunk) / router.sample_rate:.1f}s)")
    offset = 0
    while offset < len(chunk):
        piece = chunk[offset : offset + hop]
        mode, linear, dbs = router.push_chunk(piece)
        frame = render_frame(
            mode, linear, dbs, _chunk_rms_db(piece), str(router.engine.device)
        )
        sys.stdout.write("\033[2J\033[H" + frame + "\n")
        sys.stdout.flush()
        offset += hop
        time.sleep(hop_sec)


def run_input_monitor(
    router: LiveStreamRouter,
    *,
    device: int | str | None,
    loopback: bool,
    blocksize: int,
    seconds: float | None,
) -> None:
    try:
        import sounddevice as sd
    except ImportError as exc:
        raise SystemExit(
            "sounddevice is required for line-in / loopback. "
            "pip install sounddevice"
        ) from exc

    extra = None
    if loopback:
        if not hasattr(sd, "WasapiSettings"):
            raise SystemExit("WASAPI loopback needs sounddevice with WasapiSettings.")
        extra = sd.WasapiSettings(loopback=True)

    audio_q: queue.Queue[np.ndarray] = queue.Queue(maxsize=8)

    def callback(indata, frames, time_info, status):
        if status:
            print(status, file=sys.stderr)
        try:
            audio_q.put_nowait(indata.copy())
        except queue.Full:
            pass

    stream_kwargs = {
        "samplerate": router.sample_rate,
        "channels": 1,
        "dtype": "float32",
        "blocksize": blocksize,
        "callback": callback,
        "device": device,
    }
    if extra is not None:
        stream_kwargs["extra_settings"] = extra

    print(
        f"[LIVE] Input sr={router.sample_rate} device={device!r} "
        f"loopback={loopback} infer={router.engine.device}"
    )
    deadline = None if seconds is None else time.monotonic() + seconds
    with sd.InputStream(**stream_kwargs):
        while deadline is None or time.monotonic() < deadline:
            try:
                piece = audio_q.get(timeout=0.5)
            except queue.Empty:
                continue
            mono = np.asarray(piece, dtype=np.float32)
            if mono.ndim > 1:
                mono = mono.mean(axis=1)
            mode, linear, dbs = router.push_chunk(mono)
            frame = render_frame(
                mode, linear, dbs, _chunk_rms_db(mono), str(router.engine.device)
            )
            sys.stdout.write("\033[2J\033[H" + frame + "\n")
            sys.stdout.flush()


def list_devices() -> None:
    try:
        import sounddevice as sd
    except ImportError as exc:
        raise SystemExit("pip install sounddevice") from exc
    print(sd.query_devices())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Live stem-router terminal monitor")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--wav", help="Stream a WAV as if it were a live input")
    parser.add_argument("--loopback", action="store_true", help="WASAPI output loopback")
    parser.add_argument("--input-device", default=None, help="sounddevice device id/name")
    parser.add_argument("--samplerate", type=int, default=44100)
    parser.add_argument("--blocksize", type=int, default=2048)
    parser.add_argument("--hop-sec", type=float, default=0.25)
    parser.add_argument("--seconds", type=float, default=None, help="Stop after N seconds")
    parser.add_argument(
        "--infer-device",
        default="cpu",
        help="cpu (default, safe beside CUDA trainer) or cuda",
    )
    parser.add_argument(
        "--checkpoint",
        default="models/checkpoints/stem_classifier_latest.pt",
    )
    args = parser.parse_args(argv)

    if args.list_devices:
        list_devices()
        return 0

    infer = args.infer_device
    if infer == "cuda" and not torch.cuda.is_available():
        infer = "cpu"

    router = LiveStreamRouter(
        checkpoint=args.checkpoint,
        sample_rate=args.samplerate,
        device=infer,
    )

    if args.wav:
        run_wav_monitor(router, args.wav, args.hop_sec)
        return 0

    device = args.input_device
    if device is not None and str(device).isdigit():
        device = int(device)
    run_input_monitor(
        router,
        device=device,
        loopback=args.loopback,
        blocksize=args.blocksize,
        seconds=args.seconds,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n[LIVE] stopped")
        raise SystemExit(0)
