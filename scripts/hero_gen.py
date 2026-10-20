#!/usr/bin/env python3
"""hero_gen — regenerate the kite-cli hero banner deterministically.

Renders a terminal-mock hero as SVG (JetBrains Mono, site palette) and
encodes it to WebP. Upstream nikships/muse-cli shipped its hero with no
generator; this makes the fork's banner reproducible.

Usage:
  hero-gen                     # writes assets/hero.webp + site/hero.webp
  hero-gen --out x.webp --width 1568
"""

import argparse
import html
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ACCENT = "#3fb950"
BG_TOP, BG_MID, BG_BOT = "#090d12", "#0d1117", "#111820"
BORDER, DIM, FAINT = "#21262d", "#8b949e", "#484f58"
WHITE, HEADER = "#e6edf3", "#161b22"

LINES = [
    ("prompt", "status"),
    ("out", "vm 27c3a91e · agent Muse · 6 sessions · connected (noise_xx)"),
    ("prompt", 'send "summarize my unread" --wait 120'),
    ("reply", "3 unread: the weekly report is ready, a doc got shared with you,"),
    ("reply", "and tomorrow's flight checked in. Everything else is quiet."),
    ("prompt", "watch --timeout 60"),
    ("out", "… activity: file_updated /workspace/NOTES.md · task completed"),
]

BADGES = [
    ("PyPI", "v0.3.2"),
    ("transport", "Noise_XX_25519"),
    ("gateway", "258 methods"),
]


def esc(s):
    return html.escape(s, quote=True)


def line_svg(y, kind, text, mono):
    if kind == "prompt":
        return (
            f'<text x="132" y="{y}" font-family="{mono}" font-size="27" fill="{ACCENT}">$</text>'
            f'<text x="170" y="{y}" font-family="{mono}" font-size="27" fill="{WHITE}">{esc(text)}</text>'
        )
    if kind == "out":
        return f'<text x="170" y="{y}" font-family="{mono}" font-size="25" fill="{DIM}">{esc(text)}</text>'
    if kind == "reply":
        return (
            f'<rect x="156" y="{y - 30}" width="1010" height="40" rx="6" fill="{ACCENT}" opacity="0.07"/>'
            f'<rect x="156" y="{y - 30}" width="4" height="40" rx="2" fill="{ACCENT}"/>'
            f'<text x="178" y="{y}" font-family="{mono}" font-size="25" fill="{WHITE}">{esc(text)}</text>'
        )
    return ""


def build_svg(width=1568):
    mono = "JetBrains Mono, monospace"
    h = int(width * 880 / 1568)
    win_x, win_y, win_w = 80, 110, width - 160
    y = win_y + 130
    body = []
    for kind, text in LINES:
        body.append(line_svg(y, kind, text, mono))
        y += 64 if kind == "reply" else 56
    chips = []
    cx = win_x + win_w - 40
    for label, val in reversed(BADGES):
        w = 34 + 15 * (len(label) + len(val))
        cx -= w + 18
        chips.append(
            f'<rect x="{cx}" y="{win_y + 8}" width="{w}" height="34" rx="17" fill="{BG_MID}" stroke="{BORDER}"/>'
            f'<text x="{cx + w / 2}" y="{win_y + 31}" text-anchor="middle" font-family="{mono}" '
            f'font-size="17" fill="{DIM}">{esc(label)} <tspan fill="{ACCENT}">{esc(val)}</tspan></text>'
        )
    dots = "".join(
        f'<circle cx="{win_x + 36 + i * 30}" cy="{win_y + 25}" r="7.5" fill="{c}"/>'
        for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840"))
    )
    glow = (
        f'<radialGradient id="glow" cx="0.72" cy="0.18" r="0.55">'
        f'<stop offset="0%" stop-color="{ACCENT}" stop-opacity="0.10"/>'
        f'<stop offset="100%" stop-color="{ACCENT}" stop-opacity="0"/></radialGradient>'
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{h}" viewBox="0 0 {width} {h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{BG_TOP}"/><stop offset="55%" stop-color="{BG_MID}"/><stop offset="100%" stop-color="{BG_BOT}"/>
    </linearGradient>{glow}
  </defs>
  <rect width="{width}" height="{h}" fill="url(#bg)"/>
  <rect width="{width}" height="{h}" fill="url(#glow)"/>
  <text x="84" y="78" font-family="{mono}" font-weight="bold" font-size="34" fill="{WHITE}">kite-cli<tspan fill="{ACCENT}">_</tspan></text>
  <text x="{width - 84}" y="78" text-anchor="end" font-family="{mono}" font-size="22" fill="{FAINT}">your muse.ai agent, in the terminal</text>
  <rect x="{win_x}" y="{win_y}" width="{win_w}" height="{h - win_y - 60}" rx="16" fill="{BG_TOP}" stroke="{BORDER}" stroke-width="1.5"/>
  <path d="M {win_x} {win_y + 22} a 16 16 0 0 1 16 -22 h {win_w - 208} a 16 16 0 0 0 -16 -22 z" fill="none"/>
  <line x1="{win_x}" y1="{win_y + 50}" x2="{win_x + win_w}" y2="{win_y + 50}" stroke="{BORDER}" stroke-width="1.5"/>
  {dots}
  <text x="{win_x + 130}" y="{win_y + 31}" font-family="{mono}" font-size="18" fill="{FAINT}">kite-cli — zsh</text>
  {"".join(chips)}
  {"".join(body)}
</svg>'''


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=None, help="single output .webp path")
    ap.add_argument("--width", type=int, default=1568)
    ap.add_argument("--keep-svg", action="store_true")
    a = ap.parse_args()
    svg = build_svg(a.width)
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as fh:
        fh.write(svg)
        svg_path = fh.name
    outs = (
        [a.out]
        if a.out
        else [str(REPO / "assets/hero.webp"), str(REPO / "site/hero.webp")]
    )
    png = svg_path + ".png"
    subprocess.run(
        ["rsvg-convert", "-w", str(a.width), "-o", png, svg_path], check=True
    )
    for out in outs:
        subprocess.run(
            ["magick", png, "-quality", "90", "-define", "webp:method=6", out],
            check=True,
        )
        print(f"wrote {out} ({Path(out).stat().st_size} bytes)")
    if a.keep_svg:
        Path(svg_path).rename(Path(outs[0]).with_suffix(".svg"))
        print(f"kept {Path(outs[0]).with_suffix('.svg')}")
    else:
        Path(svg_path).unlink()
        Path(png).unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
