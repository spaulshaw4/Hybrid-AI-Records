"""Purge CDN cache URLs. Env tokens stay off stdout. Missing creds exit 0."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
import hybrid_env  # noqa: F401,E402


def _env(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def resolve_files(paths: list[str], base_url: str) -> list[str]:
    files: list[str] = []
    prefix = base_url.rstrip("/")
    for raw in paths:
        item = raw.strip()
        if not item:
            continue
        if item.startswith("http://") or item.startswith("https://"):
            files.append(item)
        elif prefix:
            files.append(f"{prefix}/{item.lstrip('/')}")
        else:
            files.append(item)
    return files


def purge_urls(files: list[str], token: str, zone_id: str, dry_run: bool) -> int:
    if dry_run:
        print(f"[DRY-RUN] would purge {len(files)} URL(s)")
        for url in files:
            print(f"[DRY-RUN] {url}")
        return 0

    payload = json.dumps({"files": files}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print(f"[WARN] CDN purge HTTP {exc.code}; no files cleared.", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"[WARN] CDN purge unreachable: {exc.reason}", file=sys.stderr)
        return 1
    if not body.get("success"):
        print("[WARN] CDN purge rejected by API.", file=sys.stderr)
        return 1
    print(f"[PURGED] {len(files)} URL(s)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Purge CDN file URLs. Skips if credentials are missing.")
    parser.add_argument("paths", nargs="*", help="Absolute URLs or paths under CDN_PURGE_BASE_URL.")
    parser.add_argument("--url", action="append", default=[], dest="urls")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    token = _env("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CDN_PURGE_TOKEN")
    zone_id = _env("CLOUDFLARE_ZONE_ID", "CF_ZONE_ID")
    base_url = _env("CDN_PURGE_BASE_URL")
    files = resolve_files(list(args.paths) + list(args.urls), base_url)

    if not token or not zone_id:
        print("[WARN] CDN purge credentials missing; skipping.", file=sys.stderr)
        return 0
    if not files:
        print("[WARN] no purge URLs given; skipping.", file=sys.stderr)
        return 0
    if any(not (item.startswith("http://") or item.startswith("https://")) for item in files):
        print("[WARN] CDN_PURGE_BASE_URL unset and a relative path was given; skipping.", file=sys.stderr)
        return 0

    return purge_urls(files, token, zone_id, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
