#!/usr/bin/env python3
"""
Portrait (9:16) and square (1:1) share formats, rendered from the same vector
source as the wide banner.

`generate_social_banner.py` owns the drawing primitives and the 1.91:1 layout.
This script reuses those primitives but re-composes them for other frames:
the crest and the wordmark are placed as independent groups, so a story-format
canvas gets a large crest with the type stacked beneath it instead of a
letterboxed copy of the wide banner. Everything is vector until the final
rasterise, so no size is ever upscaled from pixels.

Usage:
    python3 scripts/generate_social_formats.py [--out-dir /tmp/social]
"""
from __future__ import annotations

import argparse
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_social_banner import (  # noqa: E402
    FONT_DIR,
    centered_text,
    shield_path,
    star,
    wing,
)

# Canonical crest space (matches the wide banner's geometry exactly).
CREST_CX = 1920.0
CREST_TOP = 250.0
SHIELD_W, SHIELD_H = 720.0, 900.0
CREST_HALF_W = 880.0          # widest pinion tip, measured from CREST_CX
CREST_BOTTOM = 1300.0         # lowest ink of the wings

FORMATS = {
    "story": (1080, 1920),    # 9:16 — Reels, Stories, Shorts, TikTok
    "square": (1080, 1080),   # 1:1  — feed posts, Slack, WhatsApp, Pinterest
}


def defs() -> str:
    return """
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f9ecc4"/><stop offset="38%" stop-color="#d8b062"/>
      <stop offset="62%" stop-color="#a97c31"/><stop offset="100%" stop-color="#f2dda3"/>
    </linearGradient>
    <linearGradient id="goldSoft" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e6c684"/><stop offset="55%" stop-color="#b98f42"/>
      <stop offset="100%" stop-color="#8d6626"/>
    </linearGradient>
    <linearGradient id="ground" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="#14161a"/><stop offset="48%" stop-color="#0b0c0f"/>
      <stop offset="100%" stop-color="#050506"/>
    </linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.42" r="0.55">
      <stop offset="0%" stop-color="#5c4318" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#2a1d0a" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="crimson" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#7e1220" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#7e1220" stop-opacity="0"/>
    </radialGradient>
    """


def background(w: float, h: float, focus_y: float) -> str:
    """Guilloche ground, tuned to the frame rather than cropped from the wide art."""
    cx = w / 2
    out = [
        f'<rect width="{w}" height="{h}" fill="url(#ground)"/>',
        f'<ellipse cx="{cx}" cy="{focus_y:.0f}" rx="{w*0.62:.0f}" ry="{h*0.46:.0f}" fill="url(#crimson)"/>',
        f'<rect width="{w}" height="{h}" fill="url(#halo)"/>',
    ]
    reach = max(w, h) * 1.15
    rays = []
    for i in range(180):
        a = i * math.pi / 90
        x0, y0 = cx + math.cos(a) * reach * 0.20, focus_y + math.sin(a) * reach * 0.18
        x1, y1 = cx + math.cos(a) * reach, focus_y + math.sin(a) * reach * 0.92
        rays.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}"/>')
    out.append(
        f'<g stroke="#c9a24a" stroke-opacity="0.055" stroke-width="{max(1.0, w/1200):.2f}">'
        + "".join(rays)
        + "</g>"
    )
    step = reach * 0.055
    r = reach * 0.26
    while r < reach:
        out.append(
            f'<ellipse cx="{cx}" cy="{focus_y:.0f}" rx="{r:.0f}" ry="{r*0.92:.0f}" fill="none" '
            f'stroke="#c9a24a" stroke-opacity="0.045" stroke-width="{max(0.9, w/1600):.2f}"/>'
        )
        r += step
    m1, m2 = w * 0.030, w * 0.046
    out.append(
        f'<rect x="{m1:.1f}" y="{m1:.1f}" width="{w-2*m1:.1f}" height="{h-2*m1:.1f}" fill="none" '
        f'stroke="url(#goldSoft)" stroke-opacity="0.5" stroke-width="{max(1.4, w/540):.2f}"/>'
    )
    out.append(
        f'<rect x="{m2:.1f}" y="{m2:.1f}" width="{w-2*m2:.1f}" height="{h-2*m2:.1f}" fill="none" '
        f'stroke="#c9a24a" stroke-opacity="0.16" stroke-width="{max(0.8, w/1600):.2f}"/>'
    )
    return "".join(out)


def crest_group() -> str:
    """The winged shield + microphone, in canonical coordinates."""
    cx, stop, sw, sh = CREST_CX, CREST_TOP, SHIELD_W, SHIELD_H
    shield = shield_path(cx, stop, sw, sh)
    parts = [f'<clipPath id="shieldClip"><path d="{shield}"/></clipPath>']
    parts = [f"<defs>{''.join(parts)}</defs>"]

    wing_y = stop + sh * 0.15
    parts.append(wing(cx - sw * 0.28, wing_y, -1, 1.12,
                      ["#9b1c2b", "#e8e6e2", "#9b1c2b", "#e8e6e2"]))
    parts.append(wing(cx + sw * 0.28, wing_y, 1, 1.12,
                      ["#d8b76a", "#b8913f", "#d8b76a", "#c9a559"]))

    circ = []
    for i in range(9):
        px = cx + sw * 0.50 + (i % 3) * 104
        py = wing_y - 50 + (i // 3) * 92 + (i % 3) * 34
        circ.append(f'<circle cx="{px:.0f}" cy="{py:.0f}" r="7"/>')
        circ.append(f'<path d="M {px:.0f} {py:.0f} h 52" fill="none" stroke="#7a5a1d" '
                    f'stroke-width="5" stroke-opacity="0.55"/>')
    parts.append(f'<g fill="#7a5a1d" fill-opacity="0.6">{"".join(circ)}</g>')

    band = sh / 13.0
    stripes = "".join(
        f'<rect x="{cx-sw/2:.0f}" y="{stop + i*band:.1f}" width="{sw:.0f}" height="{band:.1f}" '
        f'fill="{"#a5182a" if i % 2 == 0 else "#f2efe9"}"/>'
        for i in range(13)
    )
    canton_w, canton_h = sw * 0.46, band * 7
    stars = []
    for row in range(5):
        cols = 5 if row % 2 == 0 else 4
        for col in range(cols):
            sx = cx - sw / 2 + canton_w * ((col + (0.5 if row % 2 else 0)) + 0.55) / 5.4
            sy = stop + canton_h * (row + 0.62) / 5.2
            stars.append(star(sx, sy, 15))
    parts.append(
        '<g clip-path="url(#shieldClip)">' + stripes
        + f'<rect x="{cx-sw/2:.0f}" y="{stop:.0f}" width="{canton_w:.0f}" height="{canton_h:.0f}" fill="#101f3d"/>'
        + f'<g fill="#f2efe9">{"".join(stars)}</g>'
        + f'<rect x="{cx-sw/2:.0f}" y="{stop:.0f}" width="{sw:.0f}" height="{sh:.0f}" fill="#000" fill-opacity="0.22"/>'
        + "</g>"
    )
    parts.append(f'<path d="{shield}" fill="none" stroke="url(#gold)" stroke-width="20"/>')
    parts.append(f'<path d="{shield}" fill="none" stroke="#5f4715" stroke-width="3" stroke-opacity="0.7"/>')

    mx, my = cx, stop + sh * 0.60
    parts.append(
        f'<g transform="rotate(-24 {mx:.0f} {my:.0f}) scale(1.22) translate({-mx*0.18:.0f},{-my*0.18:.0f})">'
        f'<rect x="{mx-62:.0f}" y="{my-150:.0f}" width="124" height="230" rx="62" '
        f'fill="url(#goldSoft)" stroke="#6b4f18" stroke-width="5"/>'
        + "".join(
            f'<line x1="{mx-40:.0f}" y1="{my-118 + i*26:.0f}" x2="{mx+40:.0f}" y2="{my-118 + i*26:.0f}" '
            f'stroke="#5c4214" stroke-width="7" stroke-opacity="0.65"/>'
            for i in range(9)
        )
        + f'<rect x="{mx-26:.0f}" y="{my+74:.0f}" width="52" height="86" rx="14" fill="url(#gold)"/>'
        f'<rect x="{mx-54:.0f}" y="{my+152:.0f}" width="108" height="26" rx="13" fill="url(#goldSoft)"/></g>'
    )
    return "".join(parts)


def type_group(width_unit: float) -> str:
    """Wordmark + rule + slogan, drawn on a baseline grid starting at y=0."""
    big = FONT_DIR / "BigShoulders-Bold.ttf"
    jura = FONT_DIR / "Jura-Medium.ttf"
    mono = FONT_DIR / "GeistMono-Regular.ttf"
    cx = 0.0
    rule = width_unit * 0.42
    gap = width_unit * 0.11
    return "".join([
        centered_text(big, "HYBRID", 300, cx, 240, 34, "url(#gold)"),
        centered_text(jura, "AI RECORDS LLC", 96, cx, 380, 40, "#d9bd77"),
        f'<line x1="{-rule:.0f}" y1="450" x2="{-gap:.0f}" y2="450" stroke="#c9a24a" stroke-opacity="0.45" stroke-width="2.5"/>',
        f'<line x1="{gap:.0f}" y1="450" x2="{rule:.0f}" y2="450" stroke="#c9a24a" stroke-opacity="0.45" stroke-width="2.5"/>',
        f'<g transform="rotate(45 0 450)"><rect x="-11" y="439" width="22" height="22" fill="#c9a24a" fill-opacity="0.8"/></g>',
        centered_text(mono, "RAW WORDS.  REAL MUSIC.  GLOBAL IMPACT.", 46, cx, 546, 12, "#8e8a83"),
    ])


TYPE_HEIGHT = 620.0  # canonical ink height of the type group (y 0 -> ~600)


def build(w: int, h: int) -> str:
    """Compose crest + type for an arbitrary frame, keeping safe margins."""
    portrait = h > w
    inner_w = w * (0.80 if portrait else 0.78)

    crest_native_w = CREST_HALF_W * 2
    crest_native_h = CREST_BOTTOM - 120.0

    # Scale the crest to the frame, then reserve room for the type beneath it.
    crest_scale = min(inner_w / crest_native_w, h * (0.44 if portrait else 0.48) / crest_native_h)
    type_scale = crest_scale * (1.02 if portrait else 0.94)
    type_h = TYPE_HEIGHT * type_scale
    crest_h = crest_native_h * crest_scale

    block_gap = h * (0.055 if portrait else 0.045)
    total = crest_h + block_gap + type_h
    top = (h - total) / 2
    focus_y = top + crest_h * 0.55

    cx = w / 2
    crest_tx = cx - CREST_CX * crest_scale
    crest_ty = top - 120.0 * crest_scale

    type_tx = cx
    type_ty = top + crest_h + block_gap

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f"<defs>{defs()}</defs>"
        + background(w, h, focus_y)
        + f'<g transform="translate({crest_tx:.2f},{crest_ty:.2f}) scale({crest_scale:.5f})">'
        + crest_group()
        + "</g>"
        + f'<g transform="translate({type_tx:.2f},{type_ty:.2f}) scale({type_scale:.5f})">'
        + type_group(crest_native_w)
        + "</g>"
        + "</svg>"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="/tmp/social")
    ap.add_argument("--supersample", type=int, default=2)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    from PIL import Image

    for name, (w, h) in FORMATS.items():
        svg = build(w, h)
        svg_path = out_dir / f"social-banner-{name}.svg"
        svg_path.write_text(svg)
        # Vector source committed alongside the wide banner.
        repo_svg = Path(f"src/assets/social-banner-{name}.svg")
        if repo_svg.parent.exists():
            repo_svg.write_text(svg)

        png = out_dir / f"social-banner-{name}.png"
        ss = args.supersample
        subprocess.run(
            ["rsvg-convert", "-w", str(w * ss), "-h", str(h * ss), str(svg_path), "-o", str(png)],
            check=True,
        )
        im = Image.open(png).convert("RGB").resize((w, h), Image.LANCZOS)
        jpg = out_dir / f"social-banner-{w}x{h}.jpg"
        im.save(jpg, quality=93, subsampling=1, optimize=True)
        print(f"{name}: {im.size} -> {jpg}")


if __name__ == "__main__":
    main()
