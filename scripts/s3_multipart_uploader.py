"""Multipart upload for vault objects. Env credentials only; abort MPU on failure."""
from __future__ import annotations

import argparse
import os
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
import hybrid_env  # noqa: F401,E402
from s3_storage_lifecycle import (  # noqa: E402
    S3ConfigError,
    compute_sha256,
    resolve_bucket,
    s3_connection_kwargs,
)

# S3 requires every part except the last to be at least 5 MiB.
MIN_PART_BYTES = 5 * 1024 * 1024
DEFAULT_PART_BYTES = MIN_PART_BYTES


def plan_parts(file_size: int, part_size: int = DEFAULT_PART_BYTES) -> list[dict]:
    """Split ``file_size`` into MPU parts. Last part may be smaller than 5 MiB."""
    chunk = max(MIN_PART_BYTES, int(part_size))
    if file_size < 0:
        raise ValueError("file_size must be >= 0")
    if file_size == 0:
        return [{"part_number": 1, "offset": 0, "length": 0}]
    parts: list[dict] = []
    offset = 0
    number = 1
    while offset < file_size:
        remaining = file_size - offset
        length = remaining if remaining <= chunk else chunk
        # Keep non-final parts at the S3 minimum even when the caller passed a smaller size.
        if remaining > chunk and length < MIN_PART_BYTES:
            length = min(MIN_PART_BYTES, remaining)
        parts.append({"part_number": number, "offset": offset, "length": length})
        offset += length
        number += 1
    return parts


def plan_upload(filepath: str, key: str, bucket: str, part_size: int = DEFAULT_PART_BYTES) -> dict:
    size = os.path.getsize(filepath)
    digest = compute_sha256(filepath)
    parts = plan_parts(size, part_size)
    return {
        "bucket": bucket,
        "key": key,
        "path": os.path.abspath(filepath),
        "bytes": size,
        "sha256": digest,
        "part_size": max(MIN_PART_BYTES, int(part_size)),
        "parts": parts,
        "part_count": len(parts),
    }


def _s3_from_env():
    import boto3

    return boto3.client("s3", **s3_connection_kwargs())


def upload_multipart(
    filepath: str,
    key: str,
    bucket_name: str | None = None,
    *,
    part_size: int = DEFAULT_PART_BYTES,
    dry_run: bool = False,
) -> dict:
    if not os.path.isfile(filepath):
        raise FileNotFoundError(filepath)
    bucket = resolve_bucket(bucket_name)
    plan = plan_upload(filepath, key, bucket, part_size)
    plan["dry_run"] = bool(dry_run)
    plan["uploaded"] = False
    if dry_run:
        return plan

    s3 = _s3_from_env()
    upload_id = None
    etags: list[dict] = []
    try:
        created = s3.create_multipart_upload(
            Bucket=bucket,
            Key=key,
            Metadata={"sha256": plan["sha256"]},
        )
        upload_id = created["UploadId"]
        with open(filepath, "rb") as handle:
            for part in plan["parts"]:
                handle.seek(part["offset"])
                body = handle.read(part["length"])
                response = s3.upload_part(
                    Bucket=bucket,
                    Key=key,
                    PartNumber=part["part_number"],
                    UploadId=upload_id,
                    Body=body,
                )
                etags.append({"ETag": response["ETag"], "PartNumber": part["part_number"]})
        s3.complete_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": etags},
        )
        plan["uploaded"] = True
        plan["upload_id"] = upload_id
        return plan
    except Exception:
        if upload_id:
            try:
                s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            except Exception as abort_exc:
                print(f"[WARN] abort_multipart_upload failed: {abort_exc}", file=sys.stderr)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="S3 multipart upload (env credentials, abort on failure).")
    parser.add_argument("--file", required=True, help="Local file. Pass a path; do not default to a live archive.")
    parser.add_argument("--key", required=True)
    parser.add_argument("--bucket", default=None)
    parser.add_argument("--part-size", type=int, default=DEFAULT_PART_BYTES)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        result = upload_multipart(
            args.file,
            args.key,
            args.bucket,
            part_size=args.part_size,
            dry_run=args.dry_run,
        )
    except S3ConfigError as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"[FATAL] missing file: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"[FAILED] multipart upload: {exc}", file=sys.stderr)
        return 1

    print(f"[PLAN] bucket={result['bucket']} key={result['key']} bytes={result['bytes']} parts={result['part_count']}")
    print(f"[PLAN] sha256={result['sha256']}")
    for part in result["parts"]:
        print(f"[PART] n={part['part_number']} offset={part['offset']} length={part['length']}")
    if result.get("dry_run"):
        print("[DRY-RUN] no bytes sent")
    elif result.get("uploaded"):
        print("[UPLOADED] multipart complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
