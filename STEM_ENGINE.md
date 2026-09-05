# Hybrid AI Neural Audio Engine v1.0.0

Engineered by Hybrid AI Records

This proprietary software engine uses a PyTorch neural network to instantly analyze raw multitrack audio, apply RMS silence gating, and autonomously compile a fully routed, color-coded Reaper session—with zero manual editing required. It accepts any standard audio format (WAV, FLAC, MP3) at any sample rate and automatically normalizes it for processing.

## 1. Install Requirements

Ensure you have Python 3.9 or newer installed. Open your terminal or command prompt inside the extracted Hybrid AI folder and run:

```bash
pip install -r requirements.txt
```

## 2. Run the Engine

Point the CLI at any folder containing your raw multitrack audio. The engine will automatically ingest the audio, calculate soft-bus probabilities via the neural model, and build the DAW envelopes.

```bash
python cli.py -i "C:\Path\To\Your\Raw_Audio_Folder"
```

If you have a supported NVIDIA GPU, append `-d cuda` for hardware acceleration. CPU processing is fully supported and highly optimized.

```bash
python cli.py -i "C:\Path\To\Your\Raw_Audio_Folder" -d cuda
```

## 3. Open Your Mix-Ready Session

Inside your audio folder, the engine has generated a new `.rpp` Reaper project file. Double-click it to open. Your session is now loaded with:

- **Pre-routed parent buses:** Drums, Bass, Vocals, Acoustic, Electric
- **Automated envelopes:** volume gating and stereo panning applied directly to the tracks
- **Transient micro-fades:** 5 ms fades instantly applied to all slice boundaries for click-free playback
- **Color-coded tracks:** immediate visual organization based on neural classification

## Extra notes

**Batch processing.** Point `-i` at a master directory that contains multiple song folders. The engine processes every subfolder in one sweep and skips utility trees (`harmonic`, `dsd100`, `logs`, `checkpoints`, `temp`, `corrupt_dsp`).

**Audio formatting.** You do not need to convert beforehand. The resampler handles 44.1 / 48 / 96 kHz, 24-bit PCM, 32-bit float, and multichannel files (downmixed to mono for classification). AIFF and OGG are also accepted.

**Live input meter.**

```bash
python engine/live_audio_monitor.py
python engine/live_audio_monitor.py --loopback
python engine/live_audio_monitor.py --infer-device cuda
```

**Weights.** Default checkpoint is `models/release/stem_classifier_v1.0.0.pt`. Override with `-c` if you pin another file.
