# Hybrid 1.0 Engine — Music Theory & DSP Logic

The transmission layer of the local engine acts as a **logical mapping bridge**, translating abstract musical theory (key centers, structural tags, tempo ratios) into exact digital signal processing (DSP) parameters on the D: drive.

---

## 1. Key Signature and Modal Mapping

When an audio loop enters `precision_slicer.py`, the engine runs a **constant-Q transform chromagram** (`librosa.feature.chroma_cqt`) to map dominant pitch classes across 12 semitones.

### The Pitch Matrix

```python
keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
chroma = librosa.feature.chroma_cqt(y=y_mono, sr=sr)
detected_key = keys[int(np.argmax(np.sum(chroma, axis=1)))]
```

### Logical Matching

When the user selects a genre lock and target BPM, `master_engine.py` queries the local manifest:

1. **Exact key match first** — Prioritizes loops in the same root key
2. **Relative/modal fallback** — Falls back to compatible scales to prevent harmonic clashes

```python
def _get_best_loop(self, genre, role, target_bpm, target_key):
    pool = [x for x in self.manifest if x["genre"] == genre and x["role"] == role]
    key_matches = [x for x in pool if x.get("key") == target_key]
    candidates = key_matches if key_matches else pool
    candidates.sort(key=lambda x: abs(x["bpm"] - target_bpm))
    return candidates[0]
```

---

## 2. Tempo and Phase-Vocoder Time-Stretching

Music theory relies on strict time grids, which the engine enforces locally via **phase vocoding**.

### Ratio Calculation

```
rate = Target BPM / Original BPM
```

The engine calculates the precise stretch factor using the mathematical ratio of target BPM against the source loop's original BPM.

### Transient Preservation

Librosa processes audio arrays locally, applying phase-vocoder stretching independently across multi-channel stems (percussion, bass, melody) so tempo changes do not:
- Introduce artifacts
- Alter the root pitch

```python
def _stretch_audio(self, audio, orig_bpm, target_bpm):
    if orig_bpm == target_bpm:
        return audio
    rate = target_bpm / orig_bpm
    if audio.ndim > 1:
        return np.array([librosa.effects.time_stretch(y=c, rate=rate) for c in audio])
    return librosa.effects.time_stretch(y=audio, rate=rate)
```

---

## 3. Structural Section Matrix

The arrangement logic maps textual tags directly to a **sample-accurate timeline** based on target BPM and time signature.

### Bar-to-Sample Conversion

A single bar duration in samples (4/4 time):

```
Bar Samples = (60.0 / BPM) × 4 × Sample Rate
```

```python
bar_len = int(((60.0 / target_bpm) * 4) * self.target_sr)
```

### Section Length Rules

| Tag | Bars | Description |
|-----|------|-------------|
| `[Intro]` | 4 | Low energy, bass muted |
| `[Verse]` | 8 | Full arrangement |
| `[Pre-Chorus]` | 4 | Building tension |
| `[Chorus]` | 8 | Full energy, all stems |
| `[Bridge]` | 4 | Breakdown, bass muted |
| `[Outro]` | 4 | Fade out, drums reduced |

### Dynamic Energy Muting

As the arranger steps through the user's layout, it applies automated logical rules:

```python
for tag in arrangement_tags:
    tag_bars = 8 if tag in ["verse", "chorus"] else 4
    section_samples = tag_bars * bar_len
    
    # Drop bass in intro/bridge for structural tension
    if tag in ["intro", "bridge"] and "bass" in stem_layers:
        stem_layers["bass"][..., current_sample:end_sample] = 0.0
    
    # Fade drums in outro
    if tag == "outro" and "drums" in stem_layers:
        fade = np.linspace(1.0, 0.2, end_sample - current_sample)
        stem_layers["drums"][..., current_sample:end_sample] *= fade
```

---

## 4. Zero-Crossing Slice Points

To prevent audio clicks at loop boundaries, the slicer snaps cut points to the nearest **zero-crossing**:

```python
def _snap_zero_crossing(self, mono, idx, radius=512):
    left = max(0, idx - radius)
    right = min(len(mono), idx + radius)
    crossings = np.where(np.diff(np.sign(mono[left:right])))[0]
    return left + crossings[np.argmin(np.abs(crossings - radius))] if len(crossings) > 0 else idx
```

---

## 5. Anti-Click Micro-Fades

All exported segments receive 5ms micro-fades at boundaries:

```python
def _apply_micro_fades(self, audio, fade_len=220):  # 220 samples ≈ 5ms @ 44.1kHz
    fade_in = np.linspace(0, 1, fade_len)
    fade_out = np.linspace(1, 0, fade_len)
    audio[:fade_len] *= fade_in
    audio[-fade_len:] *= fade_out
    return audio
```

---

## 6. Frequency-Based Role Classification

Loops are auto-classified by spectral centroid:

| Centroid Range | Role |
|----------------|------|
| < 300 Hz | `bass` |
| 300–1800 Hz | `drums` |
| > 1800 Hz | `melody` |

```python
def _classify_frequency_role(self, mono):
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=mono, sr=self.target_sr)))
    if centroid < 300:
        return "bass"
    elif 300 <= centroid < 1800:
        return "drums"
    else:
        return "melody"
```

---

---

## 7. Zero-Crossing Boundary Splice Logic

When `precision_slicer.py` slices audio blocks or concatenates arranged sections, raw cuts can cause sudden waveform jumps (digital clicks/pops). The transmission layer prevents this through sample-accurate detection.

### Polarity Crossing Search

The engine scans a local sample radius around the target cut point to find exact zero-crossings where amplitude passes through `0.0`:

```python
def _snap_zero_crossing(self, mono, idx, radius=512):
    left = max(0, idx - radius)
    right = min(len(mono), idx + radius)
    window = mono[left:right]
    
    # Find where waveform crosses zero (sign change)
    crossings = np.where(np.diff(np.sign(window)))[0]
    
    if len(crossings) > 0:
        # Snap to nearest crossing
        return left + crossings[np.argmin(np.abs(crossings - radius))]
    return idx
```

### Micro-Fade Windowing

A rapid **512-sample linear ramp** (~12ms @ 44.1kHz) is applied across boundaries of every concatenated stem slice:

```python
def _apply_boundary_fades(self, segment, fade_samples=512):
    fade_in = np.linspace(0.0, 1.0, fade_samples)
    fade_out = np.linspace(1.0, 0.0, fade_samples)
    
    segment[..., :fade_samples] *= fade_in
    segment[..., -fade_samples:] *= fade_out
    return segment
```

This smooths out phase variations between separate loops and eliminates DC offset discontinuities.

---

## 8. Frequency Spectrum Role Classification

The slicing pipeline uses local **spectral centroid analysis** to automatically categorize raw audio streams before they enter the vault manifest.

### Centroid Formula

```
Centroid = Σ(f × S(f)) / Σ(S(f))
```

Where `f` = frequency bins, `S(f)` = magnitude spectrum

### Routing Thresholds

| Centroid Range | Classification | Target Layer |
|----------------|----------------|--------------|
| **< 300 Hz** | Bass / Sub-harmonic | Low-end management |
| **300 – 1800 Hz** | Drums / Rhythm | Mid-range body |
| **> 1800 Hz** | Melody / Leads | High-frequency layer |

```python
def _classify_frequency_role(self, mono, sr):
    centroid = float(np.mean(
        librosa.feature.spectral_centroid(y=mono, sr=sr)
    ))
    
    if centroid < 300:
        return "bass"
    elif 300 <= centroid < 1800:
        return "drums"
    else:
        return "melody"
```

This maintains frequency separation before final mixdown, preventing spectral masking.

---

## 9. Master Mix Limiting and Peak Normalization

The final transmission step in `master_engine.py` combines arranged multi-track stems into a unified master array while protecting against digital clipping.

### Summation and Scaling

Individual stem matrices are summed point-by-point:

```python
# Combine all stems
mix = stem_drums + stem_bass + stem_melody

# Add vocal if present
if vocal_data is not None:
    mix = mix + vocal_data[..., :mix.shape[-1]]
```

### Peak Limiting

If absolute peak amplitude exceeds **1.0** (digital full scale), the engine normalizes:

```python
peak = np.max(np.abs(mix))

if peak > 1.0:
    mix = mix / peak  # Normalize to 0dBFS
    print(f"[LIMITER] Applied normalization (peak was {peak:.2f})")
```

This prevents harmonic distortion from clipping.

### Vault Serialization

Final uncompressed audio is written directly to the D: drive:

```python
# 16-bit PCM WAV output
sf.write(
    master_path,
    mix.T if mix.ndim > 1 else mix,
    samplerate=44100,
    subtype='PCM_16'
)

# Or 32-bit float for maximum fidelity
sf.write(master_path, mix.T, samplerate=44100, subtype='FLOAT')
```

---

## Summary

The Hybrid 1.0 engine performs **100% local DSP** with zero external audio APIs:

| Stage | Function |
|-------|----------|
| **Key Detection** | Chromagram CQT analysis |
| **Tempo Sync** | Phase-vocoder time-stretching |
| **Arrangement** | Sample-accurate section mapping |
| **Clean Edits** | Zero-crossing snapping + micro-fades |
| **Role Sorting** | Spectral centroid classification |
| **Mix Protection** | Peak limiting at 0dBFS |
| **Export** | Uncompressed WAV to D: drive |
