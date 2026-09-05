"""Real-time ANSI meter: sounddevice line-in / loopback -> LiveStreamRouter."""

from __future__ import annotations

import argparse
import os
import queue
import sys
import time

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.live_stream_router import LiveStreamRouter

CLR_RESET = "\033[0m"
CLR_BOLD = "\033[1m"
CLR_RED = "\033[91m"
CLR_GREEN = "\033[92m"
CLR_YELLOW = "\033[93m"
CLR_MAGENTA = "\033[95m"
CLR_CYAN = "\033[96m"

BUS_COLORS = {
    "beats": CLR_RED,
    "bass": CLR_CYAN,
    "voice": CLR_YELLOW,
    "acoustic": CLR_GREEN,
    "electric": CLR_MAGENTA,
}


class LiveAudioMonitor:
    def __init__(
        self,
        checkpoint="models/checkpoints/stem_classifier_latest.pt",
        sample_rate=44100,
        block_duration=4.0,
        infer_device="cpu",
    ):
        self.sample_rate = int(sample_rate)
        self.block_samples = int(self.sample_rate * block_duration)
        self.router = LiveStreamRouter(
            checkpoint=checkpoint,
            sample_rate=self.sample_rate,
            slice_duration=block_duration,
            device=infer_device,
        )
        self.engine = self.router.engine
        self.audio_buffer = np.zeros(self.block_samples, dtype=np.float32)
        self._q: queue.Queue[np.ndarray] = queue.Queue(maxsize=8)

    def draw_bar(self, percentage, width=24):
        filled = int(round(max(0.0, min(1.0, percentage)) * width))
        fill_ch, empty_ch = "#", "-"
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        if encoding.lower().replace("-", "") == "utf8":
            fill_ch, empty_ch = "█", "░"
        return fill_ch * filled + empty_ch * (width - filled)

    def audio_callback(self, indata, frames, time_info, status):
        mono = np.mean(indata, axis=1) if indata.ndim > 1 else np.asarray(indata).reshape(-1)
        try:
            self._q.put_nowait(np.asarray(mono, dtype=np.float32))
        except queue.Full:
            pass

    def _render(self, mode, probs, db_sends, rms_db, gate_status):
        infer = str(self.engine.device)
        sys.stdout.write("\033[H\033[J")
        print(f"{CLR_BOLD}========================================================================{CLR_RESET}")
        print(
            f"{CLR_BOLD} HYBRID AI LIVE INFERENCE MONITOR | {infer.upper()} ENGINE RUNNING {CLR_RESET}"
        )
        print(f"{CLR_BOLD}========================================================================{CLR_RESET}")
        print(
            f" RMS Energy : {rms_db:6.1f} dB  |  Gate : {gate_status}  |  "
            f"Mode : {CLR_BOLD}{mode}{CLR_RESET}"
        )
        print("-" * 72)
        print(f"{'STEM BUS':<12} | {'PROBABILITY':<8} | {'CONFIDENCE BAR':<26} | {'DAW SEND (dB)'}")
        print("-" * 72)
        for bus in self.router.router.buses:
            p = float(probs.get(bus, 0.0))
            db = float(db_sends.get(bus, -96.0))
            db_str = f"{db:5.1f} dB" if db > -90.0 else "  -inf dB"
            color = BUS_COLORS.get(bus, CLR_RESET)
            print(
                f"{color}{bus.upper():<12}{CLR_RESET} | {p * 100:5.1f}%   | "
                f"{color}{self.draw_bar(p)}{CLR_RESET} | {db_str}"
            )
        print("-" * 72)
        print("Press Ctrl+C to stop monitor.\n")
        sys.stdout.flush()

    def _classify_buffer(self):
        rms = float(np.sqrt(np.mean(self.audio_buffer**2) + 1e-12))
        rms_db = 20.0 * np.log10(rms)
        if rms_db < -50.0:
            mode, _linear, db_sends = self.router.router.silent_matrix()
            return (
                "IDLE",
                {b: 0.0 for b in self.router.router.buses},
                db_sends,
                rms_db,
                f"{CLR_RED}[SILENT / GATED]{CLR_RESET}",
            )
        mode, _linear, db_sends = self.router.process_buffer(self.audio_buffer)
        return (
            mode,
            dict(self.engine.last_probs),
            db_sends,
            rms_db,
            f"{CLR_GREEN}[AUDIO ACTIVE]{CLR_RESET}",
        )

    def run(self, device_index=None, loopback=False, seconds=None):
        try:
            import sounddevice as sd
        except ImportError as exc:
            raise SystemExit("sounddevice is required. pip install sounddevice") from exc

        chunk_size = int(self.sample_rate * 0.25)
        extra = None
        if loopback:
            if not hasattr(sd, "WasapiSettings"):
                raise SystemExit("WASAPI loopback needs sounddevice WasapiSettings.")
            extra = sd.WasapiSettings(loopback=True)

        print(
            f"{CLR_BOLD}Starting Live Audio Classifier Monitor "
            f"({self.engine.device} / LiveStreamRouter)...{CLR_RESET}"
        )
        kwargs = {
            "device": device_index,
            "channels": 2,
            "samplerate": self.sample_rate,
            "blocksize": chunk_size,
            "callback": self.audio_callback,
            "dtype": "float32",
        }
        if extra is not None:
            kwargs["extra_settings"] = extra

        deadline = None if seconds is None else time.monotonic() + seconds
        with sd.InputStream(**kwargs):
            while deadline is None or time.monotonic() < deadline:
                try:
                    mono = self._q.get(timeout=0.25)
                except queue.Empty:
                    mono = None
                if mono is not None:
                    n = min(len(mono), self.block_samples)
                    self.audio_buffer = np.roll(self.audio_buffer, -n)
                    self.audio_buffer[-n:] = mono[-n:]
                self._render(*self._classify_buffer())
                time.sleep(0.20)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Live ANSI stem-bus audio monitor")
    parser.add_argument("--device", type=int, default=None, help="sounddevice input index")
    parser.add_argument("--loopback", action="store_true")
    parser.add_argument("--seconds", type=float, default=None)
    parser.add_argument(
        "--infer-device",
        default="cpu",
        help="cpu (default; safe beside the CUDA trainer) or cuda",
    )
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args(argv)

    if args.list_devices:
        import sounddevice as sd

        print(sd.query_devices())
        return 0

    monitor = LiveAudioMonitor(infer_device=args.infer_device)
    monitor.run(device_index=args.device, loopback=args.loopback, seconds=args.seconds)
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nLive monitor stopped.")
        raise SystemExit(0)
