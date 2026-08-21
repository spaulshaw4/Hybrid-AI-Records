#!/usr/bin/env python3
"""
Social share-asset pipeline.

Watches the parent share banner (``src/assets/social-banner.svg``) and the
brand crest it embeds. When either changes, every downstream variant is
rebuilt from the vector source, re-uploaded to the Lovable CDN, and the
committed ``*.asset.json`` pointers are rewritten so `social-meta.ts` picks
up the new URLs with no manual edits.

Modes
-----
  python3 scripts/social_pipeline.py            # rebuild+publish if sources changed
  python3 scripts/social_pipeline.py --force    # rebuild+publish unconditionally
  python3 scripts/social_pipeline.py --check    # exit 1 if variants are stale (CI gate)
  python3 scripts/social_pipeline.py --dry-run  # rebuild locally, skip CDN upload
  python3 scripts/social_pipeline.py --watch    # poll sources and sync on change

State lives in ``src/assets/social-pipeline.manifest.json`` (committed) so the
pipeline is idempotent across machines and CI runs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "src" / "assets"
WORK = Path("/tmp/social-pipeline")
MANIFEST = ASSETS / "social-pipeline.manifest.json"

GENERATOR = ROOT / "scripts" / "generate_social_from_logo.py"

# Sources that invalidate every downstream variant.
SOURCES = [
    ASSETS / "social-banner.svg",  # parent vector
    ASSETS / "brand-crest-us.jpg",  # embedded crest artwork
    GENERATOR,  # layout/composition logic
    Path(__file__).resolve(),  # this pipeline
]

# Child SVGs regenerated from the same source of truth as the parent.
CHILD_SVGS = ["social-banner-hd.svg", "social-banner-story.svg", "social-banner-square.svg"]

# variant -> (source svg, width, height, published filename)
VARIANTS: dict[str, tuple[str, int, int, str]] = {
    "wide": ("social-banner.svg", 2400, 1260, "social-banner-wide.jpg"),
    "og1200": ("social-banner.svg", 1200, 630, "social-banner-1200x630.jpg"),
    # 16:9 comes from its own 16:9 parent — rendering the 1.905:1 banner into
    # 1920x1080 stretched the crest.
    "hd1920": ("social-banner-hd.svg", 1920, 1080, "social-banner-1920x1080.jpg"),

    "square": ("social-banner-square.svg", 1080, 1080, "social-banner-1080x1080.jpg"),
    "squareVector": (
        "social-banner-square.svg",
        1080,
        1080,
        "social-banner-vector-1080x1080.jpg",
    ),
    "story": ("social-banner-story.svg", 1080, 1920, "social-banner-1080x1920.jpg"),
    # Lossless PNG cuts for platforms/print that reject JPEG artefacts.
    "og1200png": ("social-banner.svg", 1200, 630, "social-banner-1200x630.png"),
    "squarePng": ("social-banner-square.svg", 1080, 1080, "social-banner-1080x1080.png"),
    "storyPng": ("social-banner-story.svg", 1080, 1920, "social-banner-1080x1920.png"),
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16] if path.exists() else ""


def source_fingerprint() -> dict[str, str]:
    return {str(p.relative_to(ROOT)): sha(p) for p in SOURCES}


def load_manifest() -> dict:
    if MANIFEST.exists():
        try:
            return json.loads(MANIFEST.read_text())
        except json.JSONDecodeError:
            pass
    return {}


def render(svg: Path, w: int, h: int, dest: Path) -> None:
    """Render at 2x then downsample for clean edges on small cuts."""
    raw = WORK / f"raw-{dest.stem}.png"
    scale = 2 if max(w, h) <= 2048 else 1
    subprocess.run(
        ["rsvg-convert", "-w", str(w * scale), "-h", str(h * scale), str(svg), "-o", str(raw)],
        check=True,
    )
    im = Image.open(raw).convert("RGB")
    if im.size != (w, h):
        im = im.resize((w, h), Image.LANCZOS)
    if dest.suffix == ".png":
        im.save(dest, format="PNG", optimize=True)
    else:
        im.save(dest, format="JPEG", quality=93, subsampling=1, optimize=True)


def build_all() -> dict[str, str]:
    """Regenerate the SVG family + every raster variant. Returns variant->sha."""
    WORK.mkdir(parents=True, exist_ok=True)
    # Rebuild the SVG family (parent + story + square) from the crest artwork.
    subprocess.run(
        [sys.executable, str(GENERATOR), "--out-dir", str(WORK)],
        check=True,
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
    )
    digests: dict[str, str] = {}
    for name, (svg_name, w, h, filename) in VARIANTS.items():
        dest = WORK / filename
        render(ASSETS / svg_name, w, h, dest)
        digests[name] = sha(dest)
        print(f"  built {filename} ({w}x{h})")
    return digests


def publish(dry_run: bool) -> None:
    for name, (_svg, _w, _h, filename) in VARIANTS.items():
        local = WORK / filename
        pointer = ASSETS / f"{filename}.asset.json"
        if dry_run:
            print(f"  [dry-run] would publish {filename}")
            continue
        out = subprocess.run(
            [
                "lovable-assets",
                "create",
                "--file",
                str(local),
                "--filename",
                filename,
            ],
            check=True,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        payload = json.loads(out.stdout)
        pointer.write_text(json.dumps(payload, indent=2) + "\n")
        print(f"  published {filename} -> {payload['url']}")


def write_manifest(sources: dict[str, str], digests: dict[str, str]) -> None:
    MANIFEST.write_text(
        json.dumps(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "sources": sources,
                "svgFamily": [str(Path("src/assets") / n) for n in ["social-banner.svg", *CHILD_SVGS]],
                "variants": {
                    name: {
                        "file": filename,
                        "from": svg,
                        "width": w,
                        "height": h,
                        "sha256": digests.get(name, ""),
                    }
                    for name, (svg, w, h, filename) in VARIANTS.items()
                },
            },
            indent=2,
        )
        + "\n"
    )


def sync(force: bool, dry_run: bool) -> bool:
    """Returns True when a rebuild happened."""
    sources = source_fingerprint()
    manifest = load_manifest()
    if not force and manifest.get("sources") == sources and MANIFEST.exists():
        print("social pipeline: sources unchanged, nothing to publish")
        return False
    print("social pipeline: sources changed — rebuilding variants")
    digests = build_all()
    publish(dry_run)
    if not dry_run:
        write_manifest(sources, digests)
        print(f"social pipeline: {len(VARIANTS)} variants published")
    return True


def check() -> int:
    sources = source_fingerprint()
    manifest = load_manifest()
    if not MANIFEST.exists():
        print("social pipeline: no manifest — run `bun run social:sync`", file=sys.stderr)
        return 1
    stale = {k: v for k, v in sources.items() if manifest.get("sources", {}).get(k) != v}
    missing = [
        f"{f}.asset.json"
        for (_s, _w, _h, f) in VARIANTS.values()
        if not (ASSETS / f"{f}.asset.json").exists()
    ]
    if stale or missing:
        for k in stale:
            print(f"stale source: {k}", file=sys.stderr)
        for m in missing:
            print(f"missing pointer: {m}", file=sys.stderr)
        print("run `bun run social:sync` to regenerate and republish", file=sys.stderr)
        return 1
    print("social pipeline: all variants up to date")
    return 0


def watch(interval: float, dry_run: bool) -> None:
    print(f"social pipeline: watching {len(SOURCES)} sources (every {interval:g}s) — Ctrl-C to stop")
    last = source_fingerprint()
    sync(force=False, dry_run=dry_run)
    while True:
        time.sleep(interval)
        now = source_fingerprint()
        if now != last:
            last = now
            try:
                sync(force=True, dry_run=dry_run)
            except subprocess.CalledProcessError as exc:
                print(f"social pipeline: rebuild failed ({exc})", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="rebuild even if sources are unchanged")
    ap.add_argument("--check", action="store_true", help="exit 1 when variants are stale")
    ap.add_argument("--dry-run", action="store_true", help="build locally, skip CDN upload")
    ap.add_argument("--watch", action="store_true", help="poll sources and sync on change")
    ap.add_argument("--interval", type=float, default=3.0, help="watch poll interval (seconds)")
    args = ap.parse_args()

    if args.check:
        sys.exit(check())
    if args.watch:
        watch(args.interval, args.dry_run)
        return
    sync(force=args.force, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
