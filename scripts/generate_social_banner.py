#!/usr/bin/env python3
"""
Vector source-of-truth for the 1.91:1 social share banner.

The crest, wordmark and every ornament are described as SVG geometry, so the
banner can be re-rendered at any resolution (4K today, 8K tomorrow) with zero
upscaling artifacts. Text is converted to outlines with fontTools, which frees
the render from fontconfig and guarantees identical typography everywhere.

Usage:
    python3 scripts/generate_social_banner.py [--width 3840] [--out /tmp/banner]

Outputs <out>.svg and <out>.jpg (the SVG is also written to
src/assets/social-banner.svg as the committed vector source).
"""
from __future__ import annotations

import argparse
import math
import subprocess
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

W, H = 3840, 2016  # 1.9048:1 — the ratio every social crawler expects
FONT_DIR = Path("/tmp/knowledge/skill/canvas-design/canvas-fonts")


# --------------------------------------------------------------------------- type
def text_paths(font_path: Path, text: str, size: float, tracking: float = 0.0):
    """Return (path_d, advance_width) with the string laid out as outlines."""
    font = TTFont(str(font_path))
    upem = font["head"].unitsPerEm
    scale = size / upem
    cmap = font.getBestCmap()
    glyphset = font.getGlyphSet()
    hmtx = font["hmtx"]

    d_parts: list[str] = []
    x = 0.0
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            x += size * 0.4 + tracking
            continue
        pen = SVGPathPen(glyphset)
        glyphset[name].draw(pen)
        d = pen.getCommands()
        if d:
            d_parts.append(
                f'<path d="{d}" transform="translate({x:.3f},0) scale({scale:.6f},{-scale:.6f})"/>'
            )
        x += hmtx[name][0] * scale + tracking
    return "".join(d_parts), x - tracking


def centered_text(font_path: Path, text: str, size: float, cx: float, baseline: float,
                  tracking: float, fill: str, opacity: float = 1.0) -> str:
    inner, width = text_paths(font_path, text, size, tracking)
    return (
        f'<g fill="{fill}" fill-opacity="{opacity}" '
        f'transform="translate({cx - width / 2:.2f},{baseline:.2f})">{inner}</g>'
    )


# ------------------------------------------------------------------------- shapes
def star(cx: float, cy: float, r: float) -> str:
    pts = []
    for i in range(10):
        rad = r if i % 2 == 0 else r * 0.382
        a = -math.pi / 2 + i * math.pi / 5
        pts.append(f"{cx + rad * math.cos(a):.2f},{cy + rad * math.sin(a):.2f}")
    return f'<polygon points="{" ".join(pts)}"/>'


def shield_path(cx: float, top: float, w: float, h: float) -> str:
    """Classic heraldic escutcheon: square shoulders, swept sides, pointed base."""
    hw = w / 2
    return (
        f"M {cx - hw:.1f} {top + h * 0.06:.1f} "
        f"Q {cx - hw:.1f} {top:.1f} {cx - hw + h * 0.05:.1f} {top:.1f} "
        f"L {cx + hw - h * 0.05:.1f} {top:.1f} "
        f"Q {cx + hw:.1f} {top:.1f} {cx + hw:.1f} {top + h * 0.06:.1f} "
        f"L {cx + hw:.1f} {top + h * 0.52:.1f} "
        f"C {cx + hw:.1f} {top + h * 0.80:.1f} {cx + hw * 0.62:.1f} {top + h * 0.93:.1f} "
        f"{cx:.1f} {top + h:.1f} "
        f"C {cx - hw * 0.62:.1f} {top + h * 0.93:.1f} {cx - hw:.1f} {top + h * 0.80:.1f} "
        f"{cx - hw:.1f} {top + h * 0.52:.1f} Z"
    )


def feather(cx: float, cy: float, angle: float, length: float, thick: float,
            side: int) -> str:
    """One tapered pinion, drawn as a curved lozenge sweeping away from the crest."""
    a = math.radians(angle) * side
    tipx = cx + math.cos(a) * length * side * 0 + side * length * math.cos(math.radians(angle))
    tipy = cy - length * math.sin(math.radians(angle))
    c1x = cx + side * length * 0.42
    c1y = cy - length * 0.10
    c2x = cx + side * length * 0.86
    c2y = tipy + length * 0.12
    b1x = cx + side * length * 0.40
    b1y = cy + thick * 0.95
    b2x = cx + side * length * 0.80
    b2y = tipy + length * 0.24
    return (
        f"M {cx:.1f} {cy:.1f} "
        f"C {c1x:.1f} {c1y:.1f} {c2x:.1f} {c2y:.1f} {tipx:.1f} {tipy:.1f} "
        f"C {b2x:.1f} {b2y:.1f} {b1x:.1f} {b1y:.1f} {cx:.1f} {cy + thick:.1f} Z"
    )


def wing(cx: float, cy: float, side: int, scale: float, fills: list[str]) -> str:
    """Four stacked rows of pinions — the layered heraldic wing."""
    rows = [
        (30.0, 1.00, 30.0),
        (19.0, 0.94, 30.0),
        (8.5, 0.86, 29.0),
        (-1.5, 0.74, 27.0),
    ]
    out = []
    for i, (ang, lf, th) in enumerate(rows):
        out.append(
            f'<path d="{feather(cx, cy + i * 34 * scale, ang, 560 * scale * lf, th * scale, side)}" '
            f'fill="{fills[i % len(fills)]}" stroke="#8a6a2c" stroke-width="{2.2 * scale:.1f}" '
            f'stroke-opacity="0.55"/>'
        )
    return "".join(out)


# -------------------------------------------------------------------------- build
def build_svg() -> str:
    cx = W / 2
    gold_grad = """
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f9ecc4"/>
      <stop offset="38%" stop-color="#d8b062"/>
      <stop offset="62%" stop-color="#a97c31"/>
      <stop offset="100%" stop-color="#f2dda3"/>
    </linearGradient>
    <linearGradient id="goldSoft" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e6c684"/>
      <stop offset="55%" stop-color="#b98f42"/>
      <stop offset="100%" stop-color="#8d6626"/>
    </linearGradient>
    <linearGradient id="ground" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="#14161a"/>
      <stop offset="48%" stop-color="#0b0c0f"/>
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

    # --- ground, halo, engine-turned guilloche rays -------------------------
    bg = [
        f'<rect width="{W}" height="{H}" fill="url(#ground)"/>',
        f'<ellipse cx="{cx}" cy="{H*0.46:.0f}" rx="{W*0.42:.0f}" ry="{H*0.62:.0f}" fill="url(#crimson)"/>',
        f'<rect width="{W}" height="{H}" fill="url(#halo)"/>',
    ]
    rays = []
    for i in range(180):
        a = i * math.pi / 90
        r0, r1 = 380, 1750
        x0, y0 = cx + math.cos(a) * r0, H * 0.46 + math.sin(a) * r0 * 0.86
        x1, y1 = cx + math.cos(a) * r1, H * 0.46 + math.sin(a) * r1 * 0.86
        rays.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}"/>')
    bg.append(
        '<g stroke="#c9a24a" stroke-opacity="0.055" stroke-width="1.6">'
        + "".join(rays)
        + "</g>"
    )
    for r in range(520, 1720, 96):
        bg.append(
            f'<ellipse cx="{cx}" cy="{H*0.46:.0f}" rx="{r}" ry="{r*0.86:.0f}" fill="none" '
            f'stroke="#c9a24a" stroke-opacity="0.045" stroke-width="1.4"/>'
        )
    bg.append(
        f'<rect x="54" y="54" width="{W-108}" height="{H-108}" fill="none" '
        f'stroke="url(#goldSoft)" stroke-opacity="0.5" stroke-width="3"/>'
    )
    bg.append(
        f'<rect x="74" y="74" width="{W-148}" height="{H-148}" fill="none" '
        f'stroke="#c9a24a" stroke-opacity="0.16" stroke-width="1.4"/>'
    )

    # --- crest --------------------------------------------------------------
    sw, sh = 720, 900
    stop = 250.0
    scx = cx
    shield = shield_path(scx, stop, sw, sh)

    crest = [f'<defs><clipPath id="shieldClip"><path d="{shield}"/></clipPath></defs>']

    # wings behind the shield
    wing_y = stop + sh * 0.15
    crest.append(
        wing(scx - sw * 0.28, wing_y, -1, 1.12,
             ["#9b1c2b", "#e8e6e2", "#9b1c2b", "#e8e6e2"])
    )
    crest.append(
        wing(scx + sw * 0.28, wing_y, 1, 1.12,
             ["#c9a559", "#d8b76a", "#b8913f"][1:] + ["#d8b76a"])
    )
    # circuitry etched along the right (AI) pinions — mirrored rhythm, never
    # straying past the wing silhouette
    circ = []
    for i in range(9):
        px = scx + sw * 0.50 + (i % 3) * 104
        py = wing_y - 50 + (i // 3) * 92 + (i % 3) * 34
        circ.append(f'<circle cx="{px:.0f}" cy="{py:.0f}" r="7"/>')
        circ.append(
            f'<path d="M {px:.0f} {py:.0f} h 52" fill="none" stroke="#7a5a1d" '
            f'stroke-width="5" stroke-opacity="0.55"/>'
        )
    crest.append(f'<g fill="#7a5a1d" fill-opacity="0.6">{"".join(circ)}</g>')

    # shield field: 13 stripes + canton
    stripes = []
    band = sh / 13.0
    for i in range(13):
        stripes.append(
            f'<rect x="{scx-sw/2:.0f}" y="{stop + i*band:.1f}" width="{sw}" height="{band:.1f}" '
            f'fill="{"#a5182a" if i % 2 == 0 else "#f2efe9"}"/>'
        )
    canton_w, canton_h = sw * 0.46, band * 7
    stars = []
    for row in range(5):
        cols = 5 if row % 2 == 0 else 4
        for col in range(cols):
            sx = scx - sw / 2 + canton_w * ((col + (0.5 if row % 2 else 0)) + 0.55) / 5.4
            sy = stop + canton_h * (row + 0.62) / 5.2
            stars.append(star(sx, sy, 15))
    crest.append(
        '<g clip-path="url(#shieldClip)">'
        + "".join(stripes)
        + f'<rect x="{scx-sw/2:.0f}" y="{stop:.0f}" width="{canton_w:.0f}" height="{canton_h:.0f}" fill="#101f3d"/>'
        + f'<g fill="#f2efe9">{"".join(stars)}</g>'
        + f'<rect x="{scx-sw/2:.0f}" y="{stop:.0f}" width="{sw}" height="{sh}" fill="#000" fill-opacity="0.22"/>'
        + "</g>"
    )
    crest.append(f'<path d="{shield}" fill="none" stroke="url(#gold)" stroke-width="20"/>')
    crest.append(f'<path d="{shield}" fill="none" stroke="#5f4715" stroke-width="3" stroke-opacity="0.7"/>')

    # microphone, struck across the base of the shield
    mx, my = scx, stop + sh * 0.60
    crest.append(
        f'<g transform="rotate(-24 {mx:.0f} {my:.0f}) scale(1.22) translate({-mx*0.18:.0f},{-my*0.18:.0f})">'
        f'<rect x="{mx-62:.0f}" y="{my-150:.0f}" width="124" height="230" rx="62" '
        f'fill="url(#goldSoft)" stroke="#6b4f18" stroke-width="5"/>'
        + "".join(
            f'<line x1="{mx-40:.0f}" y1="{my-118 + i*26:.0f}" x2="{mx+40:.0f}" y2="{my-118 + i*26:.0f}" '
            f'stroke="#5c4214" stroke-width="7" stroke-opacity="0.65"/>'
            for i in range(9)
        )
        + f'<rect x="{mx-26:.0f}" y="{my+74:.0f}" width="52" height="86" rx="14" fill="url(#gold)"/>'
        f'<rect x="{mx-54:.0f}" y="{my+152:.0f}" width="108" height="26" rx="13" fill="url(#goldSoft)"/>'
        f"</g>"
    )

    # --- typography ---------------------------------------------------------
    big = FONT_DIR / "BigShoulders-Bold.ttf"
    jura = FONT_DIR / "Jura-Medium.ttf"
    mono = FONT_DIR / "GeistMono-Regular.ttf"

    type_block = [
        centered_text(big, "HYBRID", 300, cx, 1560, 34, "url(#gold)"),
        centered_text(jura, "AI RECORDS LLC", 96, cx, 1700, 40, "#d9bd77"),
        f'<line x1="{cx-720:.0f}" y1="1770" x2="{cx-190:.0f}" y2="1770" stroke="#c9a24a" stroke-opacity="0.45" stroke-width="2.5"/>',
        f'<line x1="{cx+190:.0f}" y1="1770" x2="{cx+720:.0f}" y2="1770" stroke="#c9a24a" stroke-opacity="0.45" stroke-width="2.5"/>',
        f'<g transform="rotate(45 {cx:.0f} 1770)"><rect x="{cx-11:.0f}" y="1759" width="22" height="22" fill="#c9a24a" fill-opacity="0.8"/></g>',
        centered_text(mono, "RAW WORDS.  REAL MUSIC.  GLOBAL IMPACT.", 46, cx, 1866, 12, "#8e8a83"),
    ]

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}"><defs>{gold_grad}</defs>'
        + "".join(bg)
        + "".join(crest)
        + "".join(type_block)
        + "</svg>"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=3840)
    ap.add_argument("--out", default="/tmp/social-banner")
    args = ap.parse_args()

    svg = build_svg()
    src = Path("src/assets/social-banner.svg")
    if src.parent.exists():
        src.write_text(svg)
    tmp_svg = Path(f"{args.out}.svg")
    tmp_svg.write_text(svg)

    height = round(args.width * H / W)
    png = f"{args.out}.png"
    subprocess.run(
        ["rsvg-convert", "-w", str(args.width), "-h", str(height), str(tmp_svg), "-o", png],
        check=True,
    )
    from PIL import Image

    im = Image.open(png).convert("RGB")
    im.save(f"{args.out}.jpg", quality=93, subsampling=1, optimize=True)
    print(f"rendered {im.size} -> {args.out}.jpg")


if __name__ == "__main__":
    main()
