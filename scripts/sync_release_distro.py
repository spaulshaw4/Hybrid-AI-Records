"""Package a release folder, write checksums, and upload to the vault bucket.

Reuses ``_s3_client`` / env from ``s3_storage_lifecycle`` — never constructs
``boto3.client("s3")`` with empty keys. Default is dry-run; live upload
requires ``--apply``.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from s3_storage_lifecycle import (  # noqa: E402
    ALLOWED_BUCKETS,
    DEFAULT_BUCKET,
    S3ConfigError,
    _s3_client,
    compute_sha256,
    resolve_bucket,
)

# Match build_release_package companions: wav/flac/mp3/m4a/aac + json/cue.
DELIVERABLE_AUDIO = frozenset({".wav", ".flac", ".mp3", ".m4a", ".aac", ".cue"})
DELIVERABLE_JSON_HINTS = ("peak", "qc", "manifest", "report", "checksum", "cue")
SKIP_DIR_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".cursor",
        ".index",
        ".venv",
        "venv",
        "env",
        "node_modules",
        "__pycache__",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        "dist",
        "build",
        "site-packages",
        "corpus",
        "corpus_4s",
        "scratch",
        "logs",
        "MusicDatasets",
    }
)
SKIP_FILE_NAMES = frozenset(
    {
        "distribution_manifest.json",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "composer.json",
    }
)
MAX_WALK_DEPTH = 3


def _rel_posix(session_dir: str, path: str) -> str:
    rel = os.path.relpath(path, session_dir)
    return rel.replace("\\", "/")


def _is_deliverable(rel_posix: str, name: str) -> bool:
    if name.startswith(".") or name in SKIP_FILE_NAMES:
        return False
    ext = os.path.splitext(name)[1].lower()
    if ext in DELIVERABLE_AUDIO:
        return True
    if ext != ".json":
        return False
    depth = rel_posix.count("/")
    lowered = name.lower()
    if depth == 0:
        return True
    return any(token in lowered for token in DELIVERABLE_JSON_HINTS)


def collect_deliverables(session_dir: str) -> list[dict]:
    """Walk a shallow tree of release files; skip junk / unexpected dirs."""
    files: list[dict] = []
    session_dir = os.path.abspath(session_dir)
    for root, dirs, names in os.walk(session_dir):
        rel_root = _rel_posix(session_dir, root)
        depth = 0 if rel_root == "." else rel_root.count("/") + 1
        dirs[:] = [d for d in dirs if d not in SKIP_DIR_NAMES and not d.startswith(".")]
        if depth > MAX_WALK_DEPTH:
            dirs[:] = []
            continue
        for name in names:
            path = os.path.join(root, name)
            if not os.path.isfile(path):
                continue
            rel = _rel_posix(session_dir, path)
            if not _is_deliverable(rel, name):
                continue
            files.append({"name": rel, "path": path, "sha256": compute_sha256(path)})
    files.sort(key=lambda item: item["name"])
    return files


def dispatch_release_session(
    session_dir: str,
    bucket_name: str = DEFAULT_BUCKET,
    dry_run: bool | None = None,
    apply: bool = False,
) -> dict:
    if not os.path.isdir(session_dir):
        raise FileNotFoundError(f"Session release folder not found: {session_dir}")

    if dry_run is None:
        dry_run = not apply
    do_upload = bool(apply) and not bool(dry_run)

    session_id = os.path.basename(os.path.normpath(session_dir))
    bucket = resolve_bucket(bucket_name)
    files = collect_deliverables(session_dir)

    manifest = {
        "sessionId": session_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "bucket": bucket,
        "dryRun": not do_upload,
        "files": [],
    }
    action = "Would upload" if not do_upload else "Uploaded"
    print(
        f"[*] Dispatching release package [{session_id}] "
        f"({len(files)} files) to s3://{bucket}/masters/{session_id}/"
        f"{'  [DRY-RUN]' if not do_upload else ''}"
    )

    s3 = _s3_client() if do_upload else None
    for item in files:
        s3_key = f"masters/{session_id}/{item['name']}"
        if do_upload and s3 is not None:
            s3.upload_file(
                item["path"],
                bucket,
                s3_key,
                ExtraArgs={"Metadata": {"sha256": item["sha256"]}},
            )
        manifest["files"].append(
            {
                "name": item["name"],
                "sha256": item["sha256"],
                "s3_uri": f"s3://{bucket}/{s3_key}",
            }
        )
        print(f"  -> {action}: {item['name']} | Checksum: {item['sha256'][:12]}...")

    manifest_path = os.path.join(session_dir, "distribution_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    if do_upload and s3 is not None:
        s3.upload_file(manifest_path, bucket, f"masters/{session_id}/distribution_manifest.json")
    print(
        f"[DISPATCH COMPLETE] Session {session_id} is "
        f"{'dry-run listed' if not do_upload else 'vaulted and synchronized'}."
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Checksum release deliverables (wav/flac/mp3/json/cue) and write "
            "distribution_manifest.json. Default is dry-run. Live S3 upload "
            f"requires --apply and an allowed bucket ({', '.join(sorted(ALLOWED_BUCKETS))})."
        )
    )
    parser.add_argument("-s", "--session-dir", required=True)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Upload to S3. Without this flag only the local manifest is written.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List checksums and write the local manifest (default when --apply is omitted).",
    )
    args = parser.parse_args(argv)
    apply = bool(args.apply) and not bool(args.dry_run)
    try:
        dispatch_release_session(args.session_dir, bucket_name=args.bucket, apply=apply, dry_run=not apply)
    except (FileNotFoundError, S3ConfigError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
