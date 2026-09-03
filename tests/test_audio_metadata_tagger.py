import os
import struct
import sys
import tempfile
import unittest
import wave

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS = os.path.join(REPO, "scripts")
for path in (REPO, SCRIPTS):
    if path not in sys.path:
        sys.path.insert(0, path)

from audio_metadata_tagger import inject_bwf_metadata, normalise_isrc  # noqa: E402


def _write_pcm_wav(path: str) -> bytes:
    frames = b"\x00\x10" * 64
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(3)
        handle.setframerate(44100)
        handle.writeframes(frames)
    return frames


class TestAudioMetadataTagger(unittest.TestCase):
    def test_isrc_normalises(self):
        self.assertEqual(normalise_isrc("ushai2600001"), "US-HAI-26-00001")

    def test_injects_bext_and_keeps_pcm(self):
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = os.path.join(tmp, "master.wav")
            pcm = _write_pcm_wav(wav_path)
            inject_bwf_metadata(
                wav_path,
                title="Probe",
                artist="Hybrid AI Records",
                isrc="US-HAI-26-00001",
                genre="dark_techno",
                true_peak_dbtp=-1.25,
            )
            with open(wav_path, "rb") as handle:
                data = handle.read()
            self.assertEqual(data[:4], b"RIFF")
            self.assertIn(b"bext", data)
            self.assertIn(b"LIST", data)
            self.assertIn(b"ISRC", data)
            self.assertIn(pcm, data)
            size = struct.unpack_from("<I", data, 4)[0]
            self.assertEqual(size, len(data) - 8)
            with wave.open(wav_path, "rb") as handle:
                self.assertEqual(handle.getnchannels(), 1)
                self.assertEqual(handle.getsampwidth(), 3)


if __name__ == "__main__":
    unittest.main()
