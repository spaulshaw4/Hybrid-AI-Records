import numpy as np
import soundfile as sf

from dsp.tempo_time_stretch import _wsola_channel, time_stretch_wsola

SRC = r"D:\MusicDatasets\corpus_4s\001 - ANiMAL - Clinic A\vocals_s4_00002.wav"


def db(x):
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return -120.0
    return 20 * np.log10(max(1e-12, float(np.sqrt(np.mean(x**2)))))


audio, sr = sf.read(SRC, always_2d=True)
print("dtype", audio.dtype, "shape", audio.shape, db(audio))
y = np.asarray(audio[:, 0], dtype=np.float64)
print("channel 0", db(y), "max", float(np.max(np.abs(y))))

out = _wsola_channel(y, 1.0836)
print("wsola out", out.shape, db(out), "max", float(np.max(np.abs(out))))

st = time_stretch_wsola(audio, 1.0836, sr=sr)
print("time_stretch", np.asarray(st).shape, db(st))

# Where does energy go?
print("first 5000 of wsola:", db(out[:5000]))
print("mid of wsola:", db(out[80000:85000]))
print("nonzero count", int(np.count_nonzero(out)), "of", out.size)
print("channel1", db(np.asarray(audio[:, 1], dtype=np.float64)))
print("channels identical:", np.allclose(audio[:, 0], audio[:, 1]))
print("sum L+R rms", db(audio[:, 0] + audio[:, 1]))
