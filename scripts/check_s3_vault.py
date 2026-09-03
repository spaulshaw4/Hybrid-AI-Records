"""Probe S3 credentials and list vault-named buckets. Prints VAULT: and COUNT:."""
from __future__ import annotations

import os
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
import hybrid_env  # noqa: F401,E402
from s3_storage_lifecycle import _s3_client  # noqa: E402

s3 = _s3_client()
names = [bucket["Name"] for bucket in s3.list_buckets().get("Buckets", [])]
vault = [name for name in names if "vault" in name.lower()]
print("VAULT:" + ",".join(vault))
print("COUNT:" + str(len(names)))
