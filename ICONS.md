# Sutekka icons — two layers, never mixed

Core rule: decorative icons blend into the sticker world; functional icons stay
instantly readable. Mixing one style everywhere turns the UI into a sticker
book instead of a usable product.

## Layer 1 — Functional / interaction (UICONS Bold Rounded)

Used for navigation, actions and state feedback: like, comment, bookmark,
login, share, search, cart, payment. Recognisability first; cuteness never
wins over clarity.

- Library: Flaticon **UICONS**, **Bold Rounded** weight (prefix `fi-br`).
  Rounded matches the stickers' roundness; Bold matches their thick outlines.
- Delivery: CDN, one `<link>` in `web_app/index.html`:
  `https://cdn.jsdelivr.net/npm/@flaticon/flaticon-uicons@3.3.1/css/bold/rounded.css`
  (3.3.1 is the latest on npm as of 2026-11-26; Flaticon's own docs mention
  4.0.0, which had not reached npm. Do not `npm i` — the site is a static
  SPA with no package.json or bundler.)
- Usage: `<i class="fi fi-br-heart"></i>`. Sizing/alignment in
  `web_app/styles.css` under the "Flaticon UICONS" section.
- Licence: free use requires the footer attribution
  `Uicons by <a href="https://www.flaticon.com/uicons">Flaticon</a>`
  (already in the footer). Premium removes the attribution requirement —
  that is the owner's decision, not an engineering one.

Verified present in `css/bold/rounded.css` 3.3.1 (checked 2026-11-26):
`heart`, `bookmark`, `comment`, `newspaper`, `cursor-finger`, `users`,
`shopping-cart`, `credit-card`, `check-circle`, `star`, `gift`, `sparkles`,
`user`, `search`, `share`, `download`, `eye`, `calendar`, `clock`,
`arrow-right`, `x`, `plus`, `filter`, `cursor`, `hand`, `layers`, `palette`,
`star-shooting`. NOT present: `hand-pointer`, `mask`, `theater`, `smile`,
`image`, `finger`, `sparkle` — check the stylesheet before using a new name.

Current mapping (live since commit 473e95e):

| Spot | Icon |
| --- | --- |
| Like / Liked | `fi-br-heart` (liked state: accent background via `[aria-pressed="true"]`) |
| Bookmark / Saved | `fi-br-bookmark` (saved state: accent icon via `[data-bookmarked="true"]`) |
| Tap badge on sticker cells | `fi-br-cursor-finger` + 点我 |
| Column button | `fi-br-newspaper` + 专栏原文 |
| Character sheet | `fi-br-users` + 角色介绍 |
| Comments heading | `fi-br-comment` + Comments |
| Bookmarks empty state | inline `fi-br-bookmark` in the text |
| Cart / payment (when e-commerce lands) | `fi-br-shopping-cart`, `fi-br-credit-card` (Regular weight if clarity needs it) |
| Success page | one Sticker-style celebration icon from Layer 2, not a UICON |

## Layer 2 — Decorative / brand (Kawaii / Sticker SVGs)

Used for atmosphere only: empty states, success pages, profile decoration,
category labels. They carry the "cute, hand-drawn, warm" feeling.

- Source: Flaticon Kawaii or Sticker categories (SVG download).
- Style calibration (mandatory, do it for every icon before it ships):
  download the SVG, thicken the stroke, replace fills with the brand pastels
  (pink `#f6c6d8`, teal `#7fc8bc`, blue `#8fb8e8`, orange `#f2a65a`,
  accent red `#b3402a` sparingly) so outside icons fuse with the original
  stickers instead of clashing with them.
- Avatars: never use an icon with a specific face as a default avatar — use
  a silhouette or abstract shape, leaving room for the user's own customisation.
- Licence: same Flaticon free terms — attribution unless Premium.

Decorative picks are chosen on Flaticon and shown to the owner before they go
live; they are not deployed unseen.

## History

- 2026-11-26: strategy adopted (owner supplied the brief); functional layer
  implemented (commit 473e95e, deploy dpl_2yi1qR94oA5aza5hH7wsUCj3tanw),
  replacing 5 emoji spots (♥, 🔖, 👆, 📰, 🎭). Decorative picks pending
  owner's review.
