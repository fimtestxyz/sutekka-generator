#!/usr/bin/env python3
"""Build the Sticker Showcase web app data.

Scans stickers/*/ and generates:
  - web_app/data/index.json   (one record per finished sticker set)
  - web_app/thumbs/<slug>.jpg (640 px JPEG, for the home grid)
  - web_app/stickers/<slug>/sheet.png (staged copy of the set sheet)
  - web_app/stickers/<slug>/stickers/NN.png (staged copies of the
    individual stickers, for the reader's per-sticker grid)
  - web_app/og/<slug>.jpg     (1200x630 JPEG, link-preview card)
  - web_app/share/<slug>/index.html (static page with Open Graph
    tags for that set; redirects humans to the SPA reader)

Why share pages exist: the reader is a hash-routed SPA, and a
shared link used to be /#/set/<slug>. The fragment is never
sent to the server, and link-preview crawlers (WhatsApp,
Facebook, X, iMessage) do not run JavaScript — so no crawler
could ever see which set a link points to, and previews
showed a bare link with no image. Each set now gets a real
URL, /share/<slug>/, whose HTML carries that set's title,
angle and preview image. A human opening it is redirected by
JavaScript to the reader; a crawler reads the tags and stops.

Clickbait share hooks: the OG title/description on a share
page do not come from the plain title/angle. They come from
web_app/data/share.json — one punchy, set-specific headline
plus a one-line teaser per slug, written against the set's
own punchline (see the sticker script's sticker 08). A set
with no entry falls back to its title and angle. The hooks
are also copied into index.json (share_title / share_teaser)
so the reader's Share button can pass them to the native
share sheet (navigator.share title + text). New sets need a
hook entry in share.json, or they share with the plain
title/angle.

Rules (same as CI):
  - A set is listed only if it has sheet.png + brief.md + qa.md
    with a score >= 7. Anything else is reported and skipped.
  - Batch membership, series titles, tags and dates come from
    web_app/data/series.json (hand-written, rarely changes).
  - Ordering is batch descending, then series order.

Usage:
  python3 scripts/build_sticker_index.py [--check]
  --check: verify the generated index.json matches what would be
  built, without writing files (for CI).

Requires Pillow (pip install Pillow) for thumbnails.
"""

import html
import json
import os
import re
import shutil
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

# Canonical host for absolute URLs in Open Graph tags.
# PLACEHOLDER: https://sutekka-generator.vercel.app — update this
# to the real deployment URL once the Vercel project is live and
# its domain is confirmed. The share button in app.js uses
# location.origin, so it follows the host automatically.
SITE_URL = "https://sutekka-generator.vercel.app"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STICKERS_DIR = os.path.join(ROOT, "stickers")
WEBAPP_DIR = os.path.join(ROOT, "web_app")
DATA_DIR = os.path.join(WEBAPP_DIR, "data")
THUMBS_DIR = os.path.join(WEBAPP_DIR, "thumbs")
STAGED_DIR = os.path.join(WEBAPP_DIR, "stickers")
OG_DIR = os.path.join(WEBAPP_DIR, "og")
SHARE_DIR = os.path.join(WEBAPP_DIR, "share")

# QA score: the 结论/平均 line first (e.g. 结论：**PASS，8.3/10**
# or 平均：… 8.3/10), falling back to the first N.N/10 in the file.
SCORE_RE = re.compile(r"(?:结论|平均)[^0-9]*(\d+(?:\.\d+)?)\s*/\s*10")
SCORE_FALLBACK_RE = re.compile(r"(\d+(?:\.\d+)?)\s*/\s*10")
TITLE_RE = re.compile(r"^#\s+调研简报\s*[—–-]\s*(.+)$", re.M)
ANGLE_RE = re.compile(r"## 编辑角度[^\n]*\n+(.+?)(?:\n\s*\n|\Z)", re.S)
TAGS_RE = re.compile(r"^Tags:\s*(.+)$", re.M | re.I)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
STICKER_BLOCK_RE = re.compile(
    r"^###\s*(\d+)\s*[—–-]\s*(.+?)\s*$\n(.*?)(?=^###\s*\d+\s*[—–-]|\Z)",
    re.M | re.S)
JA_RE = re.compile(r"\*\*日文\*\*[：:]\s*(.+?)\s*$", re.M)
ZH_RE = re.compile(r"\*\*中文对照\*\*[：:]\s*(.+?)\s*$", re.M)


def _field(body, name):
    """Value after `- **<name>**：`, possibly wrapped over lines,
    up to the next `- **` field or the end of the block."""
    m = re.search(r"- \*\*" + name + r"\*\*[：:]\s*", body)
    if not m:
        return ""
    rest = body[m.end():]
    cut = re.search(r"\n- \*\*", rest)
    if cut:
        rest = rest[:cut.start()]
    return " ".join(line.strip() for line in rest.splitlines() if line.strip())

THUMB_WIDTH = 640
THUMB_QUALITY = 78
OG_WIDTH = 1200
OG_HEIGHT = 630
OG_QUALITY = 82


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def load_series():
    path = os.path.join(DATA_DIR, "series.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    batches = {}
    slug_to_batch = {}
    for b in data["batches"]:
        batches[b["id"]] = b
        for slug in b["slugs"]:
            if slug in slug_to_batch:
                fail(f"slug {slug} is in two batches")
            slug_to_batch[slug] = b["id"]
    return data["batches"], slug_to_batch


def load_share_hooks():
    """Clickbait share hooks: {slug: {title, teaser}}.

    Missing file or missing slug falls back to the plain title
    and angle, so a new set shares sensibly before anyone
    writes its hook. A hook entry with an empty title or teaser
    is treated as missing.
    """
    path = os.path.join(DATA_DIR, "share.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    hooks = {}
    for slug, hook in data.items():
        if not isinstance(hook, dict):
            continue
        title = (hook.get("title") or "").strip()
        teaser = (hook.get("teaser") or "").strip()
        if title and teaser:
            hooks[slug] = {"title": title, "teaser": teaser}
    return hooks


def read_cast(folder):
    """The house cast line from sticker-script.md (`- 角色：…。见 …`),
    so the reader can name the characters under the character sheet."""
    path = os.path.join(folder, "sticker-script.md")
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf-8") as f:
        txt = f.read()
    m = re.search(r"- 角色：(.+?)。见", txt, re.S)
    if not m:
        return ""
    return " ".join(m.group(1).split())


def read_column(folder):
    """The source column text as provided, stored verbatim in column.md.
    This is the set's backdrop information; the site modal shows it first."""
    path = os.path.join(folder, "column.md")
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def read_brief(folder):
    path = os.path.join(folder, "brief.md")
    with open(path, encoding="utf-8") as f:
        txt = f.read()
    m = TITLE_RE.search(txt)
    title = m.group(1).strip() if m else os.path.basename(folder)
    # Editorial angle: first non-empty line after "## 编辑角度"
    angle = ""
    m = ANGLE_RE.search(txt)
    if m:
        angle = m.group(1).strip().splitlines()[0].strip()
    tags = []
    m = TAGS_RE.search(txt)
    if m:
        tags = [t.strip() for t in m.group(1).split(",") if t.strip()]
    # The news column itself, for the reader modal: the full brief minus
    # its title line and the file-metadata bullets.
    column_lines = []
    for line in txt.splitlines():
        if line.startswith("# "):
            continue
        if line.startswith("- 专栏来源") or line.startswith("- 套装 slug"):
            continue
        column_lines.append(line)
    column_md = "\n".join(column_lines).strip()
    return title, angle, tags, column_md


def read_qa(folder):
    path = os.path.join(folder, "qa.md")
    with open(path, encoding="utf-8") as f:
        txt = f.read()
    m = SCORE_RE.search(txt)
    if not m:
        m = SCORE_FALLBACK_RE.search(txt)
    if not m:
        return None
    return float(m.group(1))


def read_script(folder):
    """Per-sticker data from sticker-script.md: one record per
    `### NN — <title>` block with its 日文 line and 中文对照 line.
    """
    path = os.path.join(folder, "sticker-script.md")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as f:
        txt = f.read()
    stickers = []
    for m in STICKER_BLOCK_RE.finditer(txt):
        n = m.group(1).strip()
        title = m.group(2).strip()
        body = m.group(3)
        ja = JA_RE.search(body)
        zh = ZH_RE.search(body)
        stickers.append({
            "n": n,
            "title": title,
            "ja": ja.group(1).strip() if ja else "",
            "zh": zh.group(1).strip() if zh else "",
            "point": _field(body, "点"),
            "scene": _field(body, "画面"),
        })
    return stickers


def make_thumb(src, dst):
    if Image is None:
        fail("Pillow is required for thumbnails: pip install Pillow")
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return False
    with Image.open(src) as im:
        im = im.convert("RGB")
        w, h = im.size
        nw = THUMB_WIDTH
        nh = round(h * nw / w)
        im = im.resize((nw, nh), Image.LANCZOS)
        im.save(dst, "JPEG", quality=THUMB_QUALITY, optimize=True)
    return True


def make_og_image(src, dst):
    """1200x630 link-preview card: the sheet scaled to 1200 px wide,
    cropped to its top strip (the first row of stickers is the teaser).
    The sheet is landscape (~2:1), so the strip is roughly its top half.
    """
    if Image is None:
        fail("Pillow is required for OG images: pip install Pillow")
    with Image.open(src) as im:
        im = im.convert("RGB")
        w, h = im.size
        nh = round(h * OG_WIDTH / w)
        height = min(OG_HEIGHT, nh)
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return False, height
    with Image.open(src) as im:
        im = im.convert("RGB")
        im = im.resize((OG_WIDTH, nh), Image.LANCZOS)
        im = im.crop((0, 0, OG_WIDTH, height))
        im.save(dst, "JPEG", quality=OG_QUALITY, optimize=True)
    return True, height


def share_page_html(record):
    slug = record["slug"]
    title = record["title"]
    # Clickbait hook when present, plain title/angle otherwise.
    hook_title = (record.get("share_title") or title).strip()
    hook_teaser = (record.get("share_teaser") or record["angle"]
                   or "Sticker set from Sticker Showcase.").strip()
    desc = hook_teaser if len(hook_teaser) <= 200 else hook_teaser[:197].rstrip() + "…"
    esc_title = html.escape(title)
    esc_hook = html.escape(hook_title)
    esc_desc = html.escape(desc)
    page_title = html.escape(f"{hook_title} — Sticker Showcase")
    share_url = f"{SITE_URL}/share/{slug}/"
    og_image = f"{SITE_URL}/og/{slug}.jpg"
    og_height = record.get("og_height", OG_HEIGHT)
    reader_url = f"/#/set/{slug}"
    # JS-only redirect on purpose: no meta refresh, so crawlers stay
    # on this page and read the tags above instead of following away.
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{page_title}</title>
<meta name="description" content="{esc_desc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Sticker Showcase">
<meta property="og:title" content="{esc_hook}">
<meta property="og:description" content="{esc_desc}">
<meta property="og:image" content="{og_image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="{og_height}">
<meta property="og:url" content="{share_url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc_hook}">
<meta name="twitter:description" content="{esc_desc}">
<meta name="twitter:image" content="{og_image}">
<link rel="canonical" href="{share_url}">
<style>body{{font-family:system-ui,sans-serif;background:#faf7f0;color:#1d1a16;margin:0;padding:48px 20px;text-align:center}}h1{{font-size:22px}}p{{color:#555;max-width:560px;margin:12px auto}}a{{color:#b3402a}}</style>
<script>location.replace('{reader_url}');</script>
</head>
<body>
<main>
<h1>{esc_hook}</h1>
<p>{esc_desc}</p>
<p>Opening the sticker set…</p>
<p><a href="{reader_url}">View {esc_title} on Sticker Showcase →</a></p>
</main>
</body>
</html>
"""


def make_share_page(record):
    slug = record["slug"]
    dst_dir = os.path.join(SHARE_DIR, slug)
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, "index.html")
    text = share_page_html(record)
    if os.path.isfile(dst):
        with open(dst, encoding="utf-8") as f:
            if f.read() == text:
                return False
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def stage_file(src, dst):
    if (not os.path.exists(dst)
            or os.path.getmtime(dst) < os.path.getmtime(src)
            or os.path.getsize(dst) != os.path.getsize(src)):
        shutil.copyfile(src, dst)
        return True
    return False


def main():
    check_only = "--check" in sys.argv
    batches, slug_to_batch = load_series()
    hooks = load_share_hooks()
    batch_by_id = {b["id"]: b for b in batches}

    records = []
    warnings = []
    errors = []
    for slug in sorted(os.listdir(STICKERS_DIR)):
        folder = os.path.join(STICKERS_DIR, slug)
        if not os.path.isdir(folder):
            continue
        img = os.path.join(folder, "sheet.png")
        if not os.path.isfile(img):
            warnings.append(f"{slug}: no sheet.png — skipped")
            continue
        if not os.path.isfile(os.path.join(folder, "brief.md")):
            errors.append(f"{slug}: missing brief.md")
            continue
        if not os.path.isfile(os.path.join(folder, "qa.md")):
            errors.append(f"{slug}: missing qa.md")
            continue
        score = read_qa(folder)
        if score is None:
            errors.append(f"{slug}: qa.md has no score /10")
            continue
        if score < 7:
            errors.append(f"{slug}: QA score {score} < 7")
            continue
        title, angle, tags, column_md = read_brief(folder)
        column_source = read_column(folder)
        cast = read_cast(folder)
        char_sheet = os.path.join(folder, "character-sheet.png")
        has_char_sheet = os.path.isfile(char_sheet)
        stickers = read_script(folder)
        if not stickers:
            warnings.append(f"{slug}: no stickers parsed from sticker-script.md")
        batch_id = slug_to_batch.get(slug)
        if batch_id is None:
            warnings.append(f"{slug}: not in any series — listed under Unsorted")
            batch = {"id": 0, "title": "Unsorted", "date": "2026-11-25",
                     "tags": []}
            order = 999
        else:
            batch = batch_by_id[batch_id]
            order = batch["slugs"].index(slug)
        all_tags = []
        for t in batch.get("tags", []) + tags:
            if t not in all_tags:
                all_tags.append(t)
        lang = "en" if not CJK_RE.search(title) else "zh"
        ratio = 0.667  # fallback when Pillow is unavailable
        if Image is not None:
            with Image.open(img) as im:
                ratio = round(im.size[0] / im.size[1], 3)
        hook = hooks.get(slug, {})
        records.append({
            "slug": slug,
            "title": title,
            "lang": lang,
            "batch": batch["id"],
            "batch_title": batch["title"],
            "date": batch.get("date", "2026-11-25"),
            "tags": all_tags,
            "qa": int(score) if score == int(score) else score,
            "image": f"stickers/{slug}/sheet.png",
            "thumb": f"thumbs/{slug}.jpg",
            "ratio": ratio,
            "angle": angle,
            "column_md": column_md,
            "column_source": column_source,
            "character_sheet": f"stickers/{slug}/character-sheet.png" if has_char_sheet else None,
            "cast": cast,
            "share_title": hook.get("title") or title,
            "share_teaser": hook.get("teaser") or angle,
            "stickers": [{
                "id": f"{slug}-{s['n']}",
                "n": s["n"],
                "title": s["title"],
                "ja": s["ja"],
                "zh": s["zh"],
                "point": s.get("point", ""),
                "scene": s.get("scene", ""),
                "file": f"stickers/{slug}/stickers/{s['n']}.png",
            } for s in stickers],
            "order": order,
        })

    if errors:
        print("\n".join(errors), file=sys.stderr)
        sys.exit(1)

    # Newest first: batch descending, then series order.
    records.sort(key=lambda r: (-r["batch"], r["order"]))
    for r in records:
        del r["order"]

    index = {"generated_by": "scripts/build_sticker_index.py",
             "count": len(records),
             "sets": records}
    index_text = json.dumps(index, ensure_ascii=False, indent=2) + "\n"

    # Inventory: one row per sticker, keyed by its printed id <slug>-NN,
    # so a buyer can name exactly the sticker they want.
    inventory = {"generated_by": "scripts/build_sticker_index.py",
                 "count": sum(len(r["stickers"]) for r in records),
                 "stickers": [{
                     "id": s["id"],
                     "set_slug": r["slug"],
                     "set_title": r["title"],
                     "n": s["n"],
                     "title": s["title"],
                     "ja": s["ja"],
                     "zh": s["zh"],
                     "point": s["point"],
                     "image": s["file"],
                     "sheet": r["image"],
                 } for r in records for s in r["stickers"]]}
    inventory_text = json.dumps(inventory, ensure_ascii=False, indent=2) + "\n"

    if check_only:
        path = os.path.join(DATA_DIR, "index.json")
        if not os.path.isfile(path):
            fail("index.json missing — run the build script")
        with open(path, encoding="utf-8") as f:
            if f.read() != index_text:
                fail("index.json is stale — run scripts/build_sticker_index.py")
        print(f"index.json is fresh ({len(records)} sets)")
        inv_path = os.path.join(DATA_DIR, "inventory.json")
        if not os.path.isfile(inv_path):
            fail("inventory.json missing — run the build script")
        with open(inv_path, encoding="utf-8") as f:
            if f.read() != inventory_text:
                fail("inventory.json is stale — run scripts/build_sticker_index.py")
        print(f"inventory.json is fresh ({inventory['count']} stickers)")
        return

    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(THUMBS_DIR, exist_ok=True)
    os.makedirs(STAGED_DIR, exist_ok=True)
    os.makedirs(OG_DIR, exist_ok=True)
    os.makedirs(SHARE_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "index.json"), "w",
              encoding="utf-8") as f:
        f.write(index_text)
    with open(os.path.join(DATA_DIR, "inventory.json"), "w",
              encoding="utf-8") as f:
        f.write(inventory_text)

    thumbs_made = 0
    staged = 0
    og_made = 0
    share_made = 0
    for r in records:
        src = os.path.join(STICKERS_DIR, r["slug"], "sheet.png")
        dst_thumb = os.path.join(THUMBS_DIR, r["slug"] + ".jpg")
        if make_thumb(src, dst_thumb):
            thumbs_made += 1
        dst_dir = os.path.join(STAGED_DIR, r["slug"])
        os.makedirs(dst_dir, exist_ok=True)
        if stage_file(src, os.path.join(dst_dir, "sheet.png")):
            staged += 1
        if r.get("character_sheet"):
            src_char = os.path.join(STICKERS_DIR, r["slug"], "character-sheet.png")
            if stage_file(src_char, os.path.join(dst_dir, "character-sheet.png")):
                staged += 1
        src_stickers = os.path.join(STICKERS_DIR, r["slug"], "stickers")
        dst_stickers = os.path.join(dst_dir, "stickers")
        os.makedirs(dst_stickers, exist_ok=True)
        for s in r["stickers"]:
            src_png = os.path.join(src_stickers, s["n"] + ".png")
            if os.path.isfile(src_png):
                if stage_file(src_png, os.path.join(dst_stickers, s["n"] + ".png")):
                    staged += 1
            else:
                warnings.append(f"{r['slug']}: missing stickers/{s['n']}.png — not staged")
        wrote_og, r["og_height"] = make_og_image(src, os.path.join(OG_DIR, r["slug"] + ".jpg"))
        if wrote_og:
            og_made += 1
        if make_share_page(r):
            share_made += 1

    for w in warnings:
        print(f"warning: {w}")
    print(f"built index.json: {len(records)} sets, "
          f"{thumbs_made} thumbs (re)generated, {staged} images staged, "
          f"{og_made} OG images (re)generated, "
          f"{share_made} share pages (re)generated, "
          f"{sum(1 for r in records if r['slug'] in hooks)} share hooks applied")


if __name__ == "__main__":
    main()
