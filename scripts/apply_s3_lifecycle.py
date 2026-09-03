"""Thin CLI for vault S3 lifecycle rules. Default is dry-run.

Delegates to ``s3_storage_lifecycle`` so credentials, allowed buckets, and
the boto3 client stay in one place. Does not PUT unless ``--apply`` is set.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
import hybrid_env  # noqa: F401,E402
from s3_storage_lifecycle import (  # noqa: E402
    ALLOWED_BUCKETS,
    DEFAULT_BUCKET,
    S3ConfigError,
    apply_bucket_lifecycle,
    is_unsupported_storage_class,
    lifecycle_configuration_json,
    resolve_bucket,
)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
    parser = argparse.ArgumentParser(
        description=(
            "Print or apply vault lifecycle rules: scratch_stems/ to Glacier IR "
            "at 30d (expire 180d); masters/ to STANDARD_IA at 90d. "
            "Default is dry-run. Live PUT requires --apply."
        )
    )
    parser.add_argument(
        "--bucket",
        default=os.environ.get("SUPABASE_S3_BUCKET", DEFAULT_BUCKET),
        help=f"Must be one of: {', '.join(sorted(ALLOWED_BUCKETS))}",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="PUT the lifecycle configuration. Without this flag, only print JSON.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print JSON and do not PUT (default when --apply is omitted).",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="On --apply, replace the bucket lifecycle instead of merging by rule ID.",
    )
    args = parser.parse_args(argv)

    apply = bool(args.apply) and not args.dry_run
    try:
        bucket = resolve_bucket(args.bucket)
    except S3ConfigError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1

    if not apply:
        print(f"[DRY-RUN] bucket={bucket}  (no PUT; pass --apply to write)")
        print(lifecycle_configuration_json())
        print(
            "[NOTE] put_bucket_lifecycle_configuration replaces the bucket policy. "
            "--apply merges by rule ID unless --replace is set."
        )
        print(
            "[NOTE] S3-compatible endpoints (Supabase) often reject GLACIER_IR "
            "and STANDARD_IA; --apply will report that instead of crashing."
        )
        return 0

    try:
        result = apply_bucket_lifecycle(
            bucket,
            apply=True,
            merge_existing=not args.replace,
        )
    except S3ConfigError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        if is_unsupported_storage_class(exc):
            print(
                "[ERROR] endpoint does not support this storage class "
                "(GLACIER_IR / STANDARD_IA). Common on S3-compatible hosts "
                "such as Supabase Storage.",
                file=sys.stderr,
            )
            return 1
        print(f"[ERROR] lifecycle apply failed: {exc}", file=sys.stderr)
        return 1

    print(f"[APPLIED] bucket={result['bucket']} merged={result['merged']}")
    print(json.dumps(result["configuration"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
