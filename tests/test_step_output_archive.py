"""A render's full console output must survive the 1200-char inline cap."""
from __future__ import annotations

import os
import sys
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from api import headless_job_runner as runner  # noqa: E402


class TestStepOutputArchive(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self._saved = runner.LIVE_LOG_DIR
        runner.LIVE_LOG_DIR = self.tmp.name

    def tearDown(self):
        runner.LIVE_LOG_DIR = self._saved
        self.tmp.cleanup()

    def test_keeps_diagnostics_the_inline_cap_would_drop(self):
        """[ARRANGE] sits far more than 1200 chars from the end of a render."""
        stdout = "[ARRANGE] section map active\n" + ("x" * 4000) + "\n[SUCCESS] done\n"
        path = runner._archive_step_output("ht_test", "generate", stdout, None)
        self.assertIsNotNone(path)
        body = open(path, encoding="utf-8").read()
        self.assertIn("[ARRANGE] section map active", body)
        self.assertIn("[SUCCESS] done", body)
        self.assertNotIn("[ARRANGE]", stdout.strip()[-1200:])  # the cap really drops it

    def test_stderr_is_appended_under_a_marker(self):
        path = runner._archive_step_output("ht_test", "generate", "out", "boom")
        body = open(path, encoding="utf-8").read()
        self.assertIn("--- stderr ---", body)
        self.assertIn("boom", body)

    def test_named_per_session_and_step(self):
        runner._archive_step_output("ht_abc", "master", "hello", None)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, "ht_abc.master.log")))

    def test_empty_output_writes_nothing(self):
        self.assertIsNone(runner._archive_step_output("ht_test", "generate", "   ", None))
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_secrets_are_redacted(self):
        path = runner._archive_step_output(
            "ht_test", "generate", "replicate_token=abcdef123", None
        )
        self.assertNotIn("abcdef123", open(path, encoding="utf-8").read())

    def test_an_unwritable_directory_does_not_fail_the_render(self):
        runner.LIVE_LOG_DIR = os.path.join(self.tmp.name, "f.txt")
        open(runner.LIVE_LOG_DIR, "w").close()  # a file where a dir is expected
        self.assertIsNone(runner._archive_step_output("ht_test", "generate", "out", None))


if __name__ == "__main__":
    unittest.main()
