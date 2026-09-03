import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS = os.path.join(REPO, "scripts")
for path in (REPO, SCRIPTS):
    if path not in sys.path:
        sys.path.insert(0, path)

from stem_mix_balancer import StemMixError, balance_mix, collect_audio_paths, rms_dbfs  # noqa: E402


class TestStemMixBalancer(unittest.TestCase):
    def test_target_rms_and_peak_safety(self):
        loud = np.ones((2048, 2), dtype=np.float64) * 0.8
        mix = balance_mix([loud], target_rms_dbfs=-18.0, peak_safety=0.95)
        self.assertLessEqual(float(np.max(np.abs(mix))), 0.95 + 1e-9)
        self.assertGreater(rms_dbfs(mix), -40.0)

    def test_library_raises_on_empty(self):
        with self.assertRaises(StemMixError):
            balance_mix([])

    def test_no_recursive_walk_by_default(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            nested = os.path.join(tmp, "slices", "dump")
            os.makedirs(nested)
            open(os.path.join(nested, "x.wav"), "wb").close()
            found = collect_audio_paths([tmp], recursive=False)
            self.assertEqual(found, [])
            found_all = collect_audio_paths([tmp], recursive=True)
            self.assertEqual(len(found_all), 1)


if __name__ == "__main__":
    unittest.main()
