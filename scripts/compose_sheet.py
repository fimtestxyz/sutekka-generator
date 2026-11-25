#!/usr/bin/env python3
"""Recompose a set's sheet.png from its sticker files.

Layout (matches the sheets shipped with both sets): 3320x1672 white
canvas, 4x2 grid, each cell 800px wide; cell origin x = col*840,
y = 24 + row*824. Each sticker is contain-fitted into its 800x800 cell
and centred, so tagged stickers (taller, with the footer strip) and
odd-sized ones compose cleanly.

Usage: python3 scripts/compose_sheet.py [slug ...]
  With no slug, recomposes every set that has a stickers/ folder.
"""

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STICKERS_DIR = os.path.join(ROOT, "stickers")
CANVAS = (3320, 1672)
CELL = 800


def compose(slug):
    folder = os.path.join(STICKERS_DIR, slug, "stickers")
    files = sorted(f for f in os.listdir(folder) if f.endswith(".png"))
    if len(files) != 8:
        print(f"{slug}: expected 8 stickers, found {len(files)} — skipped")
        return False
    sheet = Image.new("RGB", CANVAS, "white")
    for i, name in enumerate(files):
        im = Image.open(os.path.join(folder, name)).convert("RGB")
        im.thumbnail((CELL, CELL), Image.LANCZOS)
        col, row = i % 4, i // 4
        x = col * 840 + (CELL - im.width) // 2
        y = 24 + row * 824 + (CELL - im.height) // 2
        sheet.paste(im, (x, y))
    out = os.path.join(STICKERS_DIR, slug, "sheet.png")
    sheet.save(out, "PNG")
    print(f"{slug}: sheet.png recomposed ({sheet.size[0]}x{sheet.size[1]})")
    return True


def main():
    slugs = sys.argv[1:] or sorted(
        s for s in os.listdir(STICKERS_DIR)
        if os.path.isdir(os.path.join(STICKERS_DIR, s, "stickers")))
    ok = all(compose(s) for s in slugs)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
