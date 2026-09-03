import hashlib
import os
import sys
import tempfile
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS = os.path.join(REPO, "scripts")
for path in (REPO, SCRIPTS):
    if path not in sys.path:
        sys.path.insert(0, path)

from s3_multipart_uploader import MIN_PART_BYTES, plan_parts, plan_upload, upload_multipart  # noqa: E402


class TestS3MultipartUploader(unittest.TestCase):
    def test_part_math_and_tiny_file_dry_run(self):
        parts = plan_parts(MIN_PART_BYTES * 2 + 100, MIN_PART_BYTES)
        self.assertEqual(len(parts), 3)
        self.assertEqual(parts[0]["length"], MIN_PART_BYTES)
        self.assertEqual(parts[-1]["length"], 100)
        self.assertEqual(sum(part["length"] for part in parts), MIN_PART_BYTES * 2 + 100)

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tiny.bin")
            payload = b"hybrid-tiny-part-test"
            with open(path, "wb") as handle:
                handle.write(payload)
            plan = upload_multipart(path, "masters/test/tiny.bin", "vault-storage", dry_run=True)
            self.assertTrue(plan["dry_run"])
            self.assertFalse(plan["uploaded"])
            self.assertEqual(plan["bytes"], len(payload))
            self.assertEqual(plan["part_count"], 1)
            expected = hashlib.sha256(payload).hexdigest()
            self.assertEqual(plan["sha256"], expected)
            rebuilt = plan_upload(path, "masters/test/tiny.bin", "vault-storage")
            self.assertEqual(rebuilt["sha256"], expected)


if __name__ == "__main__":
    unittest.main()
