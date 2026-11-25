#!/usr/bin/env python3
"""Print the inventory tag on every sticker.

Rule (SPEC): every sticker set has an English slug, and every sticker in
it carries the id `<slug>-NN` (two-digit number), printed at the bottom
of the delivered sticker file so a buyer can name exactly the sticker
they want. The tag is a white footer strip with the id centred in ink —
it never touches the artwork, so it works for any sticker regardless of
how close the art runs to the edge.

Usage: python3 scripts/tag_stickers.py [--check]
  --check: report which stickers are untagged without changing anything.

Idempotency: scripts/tagged.json records the sha256 of each tagged file.
A file already in the manifest with a matching sha is skipped; a file in
the manifest whose art changed is skipped with a warning (untag it by
hand from git history first, then re-run).
"""

import hashlib
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STICKERS_DIR = os.path.join(ROOT, "stickers")
MANIFEST = os.path.join(ROOT, "scripts", "tagged.json")
FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
INK = (0x1D, 0x1A, 0x16)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def tag_file(path, sticker_id):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    footer_h = max(64, round(h * 0.05))
    font_size = max(36, round(w / 36))
    font = ImageFont.truetype(FONT, font_size)
    out = Image.new("RGB", (w, h + footer_h), "white")
    out.paste(im, (0, 0))
    draw = ImageDraw.Draw(out)
    bbox = draw.textbbox((0, 0), sticker_id, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (w - tw) // 2 - bbox[0]
    y = h + (footer_h - th) // 2 - bbox[1]
    draw.text((x, y), sticker_id, font=font, fill=INK)
    out.save(path, "PNG")
    return out.size


def main():
    check_only = "--check" in sys.argv
    manifest = {}
    if os.path.isfile(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            manifest = json.load(f)

    tagged, skipped, warnings = [], [], []
    for slug in sorted(os.listdir(STICKERS_DIR)):
        folder = os.path.join(STICKERS_DIR, slug, "stickers")
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if not name.endswith(".png"):
                continue
            n = name[:-4]
            sticker_id = f"{slug}-{n}"
            path = os.path.join(folder, name)
            current = sha256(path)
            entry = manifest.get(sticker_id)
            if entry and entry.get("sha256") == current:
                skipped.append(sticker_id)
                continue
            if entry and entry.get("sha256") != current:
                warnings.append(
                    f"{sticker_id}: already tagged but art changed — "
                    "restore the untagged original from git, then re-run")
                continue
            if check_only:
                print(f"untagged: {sticker_id}")
                continue
            size = tag_file(path, sticker_id)
            manifest[sticker_id] = {"sha256": sha256(path), "size": list(size)}
            tagged.append(sticker_id)

    if warnings:
        for w in warnings:
            print(f"warning: {w}")
    if check_only:
        print(f"{len(tagged)} untagged, {len(skipped)} already tagged")
        return
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"tagged {len(tagged)} stickers, skipped {len(skipped)} already tagged")
    for t in tagged:
        print(f"  {t}")


if __name__ == "__main__":
    main()
