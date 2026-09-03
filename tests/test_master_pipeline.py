import json
import os
import shutil
import subprocess
import sys
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STUDIO = os.path.join(r"D:\MusicDatasets\scripts", "studio_master_chain.py")
QC_GATE = os.path.join(REPO, "scripts", "qc_master_gate.py")
PYTHON = sys.executable


class TestMasteringPipeline(unittest.TestCase):
    def setUp(self):
        if not os.path.isdir(r"D:\MusicDatasets"):
            self.skipTest("workstation volume D:\\MusicDatasets is not mounted")
        self.test_dir = r"D:\MusicDatasets\scratch\test_session_ci"
        os.makedirs(self.test_dir, exist_ok=True)
        self.raw_master = os.path.join(self.test_dir, "master_output.wav")
        self.sr = 44100
        self.duration = 4.0
        t = np.linspace(0, self.duration, int(self.sr * self.duration), endpoint=False)
        left = 0.6 * np.sin(2 * np.pi * 120 * t)
        right = 0.6 * np.sin(2 * np.pi * 120 * t)
        sf.write(self.raw_master, np.column_stack((left, right)), self.sr, subtype="PCM_24")

    def test_dsp_chain_compliance(self):
        if not os.path.isfile(STUDIO):
            self.skipTest(f"workstation chain missing: {STUDIO}")
        self.assertTrue(os.path.isfile(QC_GATE), f"missing {QC_GATE}")

        res = subprocess.run(
            [PYTHON, STUDIO, "-i", self.raw_master, "-o", self.raw_master, "--genre", "nu_metal"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(res.returncode, 0, f"DSP Chain failed: {res.stderr}\n{res.stdout}")

        qc_res = subprocess.run(
            [PYTHON, QC_GATE, "-i", self.raw_master],
            capture_output=True,
            text=True,
        )
        self.assertEqual(qc_res.returncode, 0, f"QC Gate script failed: {qc_res.stderr}")
        metrics = json.loads(qc_res.stdout)
        self.assertLessEqual(metrics["true_peak_dbtp"], -0.50, "True peak exceeds -0.50 dBTP limit")
        self.assertGreaterEqual(
            metrics["phase_correlation"],
            0.80,
            "Phase correlation dropped below 0.80 threshold",
        )

    def tearDown(self):
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
