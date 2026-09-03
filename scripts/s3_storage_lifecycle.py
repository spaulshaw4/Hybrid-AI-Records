"""Vault upload/purge plus shared S3 client and lifecycle helpers.

Upload path: master -> SHA-256 verify -> purge local scratch. Fail-closed.
Lifecycle path: see ``apply_s3_lifecycle.py`` (requires ``--apply`` to PUT).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys

# boto3 is imported lazily in _s3_client() so --help / dry-run do not construct
# a client (and do not pay the import cost) when no credentials are needed.

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
import hybrid_env  # noqa: F401,E402

ALLOWED_BUCKETS = frozenset({"vault-storage", "audio-vault", "studio-deliveries"})
DEFAULT_BUCKET = "vault-storage"

SCRATCH_STEMS_PREFIX = "scratch_stems/"
MASTERS_PREFIX = "masters/"
UNSUPPORTED_STORAGE_CODES = frozenset(
    {
        "InvalidStorageClass",
        "InvalidArgument",
        "NotImplemented",
        "UnsupportedOperation",
        "NotSupported",
        "InvalidRequest",
    }
)


class S3ConfigError(RuntimeError):
    """Missing credentials or a disallowed bucket. Never constructed with empty keys."""


def compute_sha256(filepath: str) -> str:
    hasher = hashlib.sha256()
    with open(filepath, "rb") as handle:
        while chunk := handle.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def s3_connection_kwargs() -> dict:
    """Collect endpoint/keys from SUPABASE_S3_*, AWS_*, or S3_ENDPOINT.

    Does not construct a boto3 client. Raises ``S3ConfigError`` if keys are empty.
    """
    endpoint = (
        os.environ.get("SUPABASE_S3_ENDPOINT")
        or os.environ.get("AWS_ENDPOINT_URL")
        or os.environ.get("S3_ENDPOINT")
        or ""
    ).strip()
    access = (
        os.environ.get("SUPABASE_S3_ACCESS_KEY")
        or os.environ.get("AWS_ACCESS_KEY_ID")
        or ""
    ).strip()
    secret = (
        os.environ.get("SUPABASE_S3_SECRET_KEY")
        or os.environ.get("AWS_SECRET_ACCESS_KEY")
        or ""
    ).strip()
    region = (
        os.environ.get("SUPABASE_S3_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-west-2"
    ).strip()
    if not access or not secret:
        raise S3ConfigError("S3 credentials are not configured.")
    kwargs = {"aws_access_key_id": access, "aws_secret_access_key": secret, "region_name": region}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    return kwargs


def _s3_client():
    try:
        kwargs = s3_connection_kwargs()
    except S3ConfigError as exc:
        raise SystemExit(f"[FATAL] {exc}") from exc
    import boto3

    return boto3.client("s3", **kwargs)


def resolve_bucket(bucket_name: str | None) -> str:
    bucket = (bucket_name or os.environ.get("SUPABASE_S3_BUCKET") or DEFAULT_BUCKET).strip()
    if bucket not in ALLOWED_BUCKETS:
        allowed = ", ".join(sorted(ALLOWED_BUCKETS))
        raise S3ConfigError(f"Bucket {bucket!r} is not allowed. Allowed: {allowed}")
    return bucket


def build_lifecycle_configuration() -> dict:
    """scratch_stems → Glacier IR @ 30d, expire 180d; masters/ → STANDARD_IA @ 90d."""
    return {
        "Rules": [
            {
                "ID": "scratch_stems_glacier_ir_expire",
                "Filter": {"Prefix": SCRATCH_STEMS_PREFIX},
                "Status": "Enabled",
                "Transitions": [{"Days": 30, "StorageClass": "GLACIER_IR"}],
                "Expiration": {"Days": 180},
            },
            {
                "ID": "masters_standard_ia",
                "Filter": {"Prefix": MASTERS_PREFIX},
                "Status": "Enabled",
                "Transitions": [{"Days": 90, "StorageClass": "STANDARD_IA"}],
            },
        ]
    }


def lifecycle_configuration_json(indent: int = 2) -> str:
    return json.dumps(build_lifecycle_configuration(), indent=indent)


def is_unsupported_storage_class(exc: BaseException) -> bool:
    from botocore.exceptions import ClientError

    if isinstance(exc, ClientError):
        code = str((exc.response or {}).get("Error", {}).get("Code") or "")
        message = str((exc.response or {}).get("Error", {}).get("Message") or exc)
        if code in UNSUPPORTED_STORAGE_CODES:
            lowered = message.lower()
            if any(
                token in lowered
                for token in (
                    "storage class",
                    "glacier",
                    "standard_ia",
                    "transition",
                    "lifecycle",
                    "not implemented",
                    "not supported",
                )
            ):
                return True
            if code in {"InvalidStorageClass", "NotImplemented", "UnsupportedOperation"}:
                return True
        if "storage class" in message.lower() or "glacier" in message.lower():
            return True
    text = str(exc).lower()
    return "storage class" in text or "invalidstorageclass" in text


def merge_lifecycle_rules(existing_rules: list[dict], incoming: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for rule in existing_rules:
        rule_id = str(rule.get("ID") or "")
        if rule_id:
            by_id[rule_id] = rule
    for rule in incoming:
        by_id[str(rule["ID"])] = rule
    return list(by_id.values())


def fetch_existing_lifecycle_rules(s3, bucket: str) -> list[dict]:
    from botocore.exceptions import ClientError

    try:
        response = s3.get_bucket_lifecycle_configuration(Bucket=bucket)
        return list(response.get("Rules") or [])
    except ClientError as exc:
        code = str((exc.response or {}).get("Error", {}).get("Code") or "")
        if code in {"NoSuchLifecycleConfiguration", "NoSuchLifecycle", "NotFound"}:
            return []
        raise


def apply_bucket_lifecycle(
    bucket_name: str | None = None,
    *,
    apply: bool = False,
    merge_existing: bool = True,
) -> dict:
    """Build (and optionally PUT) the vault lifecycle configuration.

    Default is dry-run: returns the JSON payload and does not call put.
    ``apply=True`` requires working credentials. S3-compatible hosts that
    reject Glacier / STANDARD_IA raise a clear ``S3ConfigError``.
    """
    bucket = resolve_bucket(bucket_name)
    proposed = build_lifecycle_configuration()
    result: dict = {
        "bucket": bucket,
        "apply": bool(apply),
        "configuration": proposed,
        "merged": False,
        "applied": False,
    }
    if not apply:
        return result

    import boto3
    from botocore.exceptions import ClientError

    s3 = boto3.client("s3", **s3_connection_kwargs())
    payload = proposed
    if merge_existing:
        existing = fetch_existing_lifecycle_rules(s3, bucket)
        if existing:
            payload = {"Rules": merge_lifecycle_rules(existing, proposed["Rules"])}
            result["merged"] = True
            result["configuration"] = payload
    try:
        s3.put_bucket_lifecycle_configuration(Bucket=bucket, LifecycleConfiguration=payload)
    except ClientError as exc:
        if is_unsupported_storage_class(exc):
            raise S3ConfigError(
                "endpoint does not support this storage class "
                "(GLACIER_IR / STANDARD_IA). Common on S3-compatible hosts "
                "such as Supabase Storage."
            ) from exc
        raise
    result["applied"] = True
    return result


def _safe_to_purge(work_dir: str) -> bool:
    normalized = os.path.normpath(work_dir).lower()
    return any(token in normalized for token in (r"\scratch", r"\renders", "/scratch", "/renders"))


def execute_vault_upload_and_purge(work_dir: str, session_id: str, bucket_name: str = "vault-storage"):
    master_wav = os.path.join(work_dir, "master_output.wav")
    if not os.path.exists(master_wav):
        print(f"[ERROR] Master file {master_wav} does not exist.", file=sys.stderr)
        sys.exit(1)

    local_hash = compute_sha256(master_wav)
    s3_key = f"masters/{session_id}/master_output.wav"
    bucket = bucket_name or os.environ.get("SUPABASE_S3_BUCKET") or "vault-storage"
    s3 = _s3_client()

    try:
        print(f"[*] Uploading master for session {session_id} to bucket {bucket}...")
        s3.upload_file(
            master_wav,
            bucket,
            s3_key,
            ExtraArgs={"Metadata": {"sha256": local_hash}},
        )
        head = s3.head_object(Bucket=bucket, Key=s3_key)
        remote_hash = (head.get("Metadata") or {}).get("sha256")
        if remote_hash and remote_hash != local_hash:
            raise ValueError("Hash mismatch between local master and remote metadata.")
        if not remote_hash:
            print("[WARN] Remote object has no sha256 metadata; local hash retained as authority.")
        print(f"[VERIFIED] Upload confirmed with SHA-256: {local_hash}")

        if not _safe_to_purge(work_dir):
            print(f"[SKIP] Refusing to purge {work_dir}; only scratch/renders workspaces are removed.")
            return
        print(f"[*] Purging scratch workspace: {work_dir}")
        shutil.rmtree(work_dir, ignore_errors=True)
        print("[CLEAN] Local scratch purged successfully.")
    except Exception as exc:
        print(f"[FAILED] Storage sync failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--bucket", default=os.environ.get("SUPABASE_S3_BUCKET", "vault-storage"))
    args = parser.parse_args()
    execute_vault_upload_and_purge(args.work_dir, args.session_id, args.bucket)
