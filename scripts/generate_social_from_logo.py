#!/usr/bin/env python3
"""
Rebuilds the share-banner SVG family around the real brand crest artwork.

The previous vector banners re-drew an approximation of the eagle crest. The
official logo (golden eagle over the US-flag shield, AI circuit wing, gold
microphone, HYBRID(TM) AI RECORDS LLC wordmark) is now embedded directly, so
every generated format shows the actual mark instead of a lookalike.

Usage: python3 scripts/generate_social_from_logo.py [--logo path] [--out-dir dir]
"""
from __future__ import annotations

import argparse
import base64
import io
import subprocess
from pathlib import Path

from PIL import Image

FORMATS = {
    # name: (width, height, repo svg name)
    "parent": (3840, 2016, "social-banner.svg"),
    # Dedicated 16:9 parent so the HD cut is composed, never stretched from 1.905:1.
    "hd": (1920, 1080, "social-banner-hd.svg"),
    "story": (1080, 1920, "social-banner-story.svg"),
    "square": (1080, 1080, "social-banner-square.svg"),
}


DEFS = """
    <linearGradient id="goldSoft" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e6c684"/><stop offset="55%" stop-color="#b98f42"/>
      <stop offset="100%" stop-color="#8d6626"/>
    </linearGradient>
    <linearGradient id="ground" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="#14161a"/><stop offset="48%" stop-color="#0b0c0f"/>
      <stop offset="100%" stop-color="#050506"/>
    </linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.62">
      <stop offset="0%" stop-color="#5c4318" stop-opacity="0.45"/>
      <stop offset="55%" stop-color="#2a1d0a" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="crimson" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#7e1220" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="#7e1220" stop-opacity="0"/>
    </radialGradient>
"""


def logo_data_uri(path: Path, max_edge: int) -> tuple[str, int, int]:
    im = Image.open(path).convert("RGB")
    if max(im.size) > max_edge:
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=92, subsampling=1, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}", im.width, im.height


def build(w: int, h: int, uri: str, lw: int, lh: int) -> str:
    pad = min(w, h) * 0.085
    frame = min(w, h) * 0.014
    # Keep the whole lockup inside the centre square so platforms that
    # centre-crop a wide banner (Messenger, WhatsApp, Slack) never clip it.
    safe = min(w, h) - 2 * pad
    scale = min(safe / lw, safe / lh)
    dw, dh = lw * scale, lh * scale
    dx, dy = (w - dw) / 2, (h - dh) / 2
    # Feather proportional to the canvas: a fixed blur is invisible at 4K and
    # leaves a hard rectangular seam around the artwork.
    blur = max(2.0, min(w, h) * 0.022)
    inset = blur * 1.6
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}"><defs>{DEFS}'
        f'    <filter id="feather" x="-20%" y="-20%" width="140%" height="140%">'
        f'      <feGaussianBlur stdDeviation="{blur:.2f}"/>'
        f'    </filter>'
        f'</defs>'
        f'<rect width="{w}" height="{h}" fill="url(#ground)"/>'
        f'<ellipse cx="{w/2:.1f}" cy="{h/2:.1f}" rx="{w*0.46:.1f}" ry="{h*0.6:.1f}" fill="url(#crimson)"/>'
        f'<rect width="{w}" height="{h}" fill="url(#halo)"/>'
        f'<mask id="logoMask"><rect x="{dx+inset:.2f}" y="{dy+inset:.2f}" '
        f'width="{max(dw-2*inset,1):.2f}" height="{max(dh-2*inset,1):.2f}" rx="{blur*2:.2f}" '
        f'fill="#fff" filter="url(#feather)"/></mask>'
        f'<image mask="url(#logoMask)" href="{uri}" x="{dx:.2f}" y="{dy:.2f}" width="{dw:.2f}" height="{dh:.2f}" '
        f'preserveAspectRatio="xMidYMid meet"/>'
        f'<rect x="{frame*1.6:.1f}" y="{frame*1.6:.1f}" width="{w-frame*3.2:.1f}" height="{h-frame*3.2:.1f}" '
        f'fill="none" stroke="url(#goldSoft)" stroke-opacity="0.55" stroke-width="{frame*0.45:.1f}"/>'
        f'<rect x="{frame*2.8:.1f}" y="{frame*2.8:.1f}" width="{w-frame*5.6:.1f}" height="{h-frame*5.6:.1f}" '
        f'fill="none" stroke="#c9a24a" stroke-opacity="0.18" stroke-width="{frame*0.2:.1f}"/>'
        "</svg>"
    )



def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logo", default="src/assets/brand-crest-us.jpg")
    ap.add_argument("--out-dir", default="/tmp/social")
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    uri, lw, lh = logo_data_uri(Path(args.logo), 1400)

    for name, (w, h, repo_name) in FORMATS.items():
        svg = build(w, h, uri, lw, lh)
        svg_path = out / repo_name
        svg_path.write_text(svg)
        Path("src/assets") / repo_name
        (Path("src/assets") / repo_name).write_text(svg)

        png = out / f"{name}.png"
        subprocess.run(
            ["rsvg-convert", "-w", str(w), "-h", str(h), str(svg_path), "-o", str(png)],
            check=True,
        )
        im = Image.open(png).convert("RGB")
        im.save(out / f"social-banner-{w}x{h}.jpg", quality=93, subsampling=1, optimize=True)
        print(f"{name}: {im.size}")


if __name__ == "__main__":
    main()
