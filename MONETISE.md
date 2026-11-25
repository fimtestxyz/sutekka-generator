# Sutekka — Monetisation Plan

> Written as the project's ecommerce marketing manager + payments lead.
> Status: **plan, not yet decided** — prices are starting points to test,
> fees are checked 2026-11-25 (sources at the bottom), nothing here has
> been committed to any platform yet.

## 1. Verdict (read this first)

Sutekka is sellable today, but only in one form: **digital stickers
sold by id from the site we already run**. The inventory system is the
whole business enabler — every sticker is already a SKU
(`<slug>-NN`, printed on the file, listed in `inventory.json`), so the
shop is a thin layer on top of data we already generate. Do not build a
storefront. Do not print physical stock yet.

**Phase 1 (this week):** Stripe Payment Links on the existing site —
one link per set, one per single sticker, one per 30-piece pack. Buyer
pays, gets the PNG by email/download. No account, no cart, no backend.

**Phase 2 (after 50 paid orders):** Etsy listings for the same digital
files, for discovery only — Etsy brings strangers, we pay for it in
fees. Keep the own site as home.

**Phase 3 (only if Phase 1 proves demand):** physical die-cut vinyl
stickers, print-on-demand, no inventory held. Get a physical sample
before selling a single one.

## 2. What we're selling

The product is not "a PNG". It is **a numbered piece of a news story**:
the column explains the event, the sticker is the punchline, the printed
id is the proof you own that exact one. That is the whole pitch, and it
only works because the id is printed on the file (SPEC §8 rule 7).

| Product | Contents | Format |
|---|---|---|
| Single sticker | 1 PNG, id printed | Digital download |
| Full set | 8 PNGs of one column | Digital download |
| 30-piece pack | 30 PNGs, curated across sets (SPEC §10) | Digital download |
| Physical single | 1 die-cut vinyl sticker | Shipped (Phase 3) |
| Physical set / pack | 8 / 30 die-cut stickers | Shipped (Phase 3) |

Digital first because the marginal cost is zero, delivery is instant,
and there is no print quality to get wrong. Physical only after buyers
have proven they want the art on something they can stick.

## 3. Who buys, and why

- **Column readers** — they read the story, they want the punchline.
  The buy button belongs on the reader page, under the sticker, not on
  a separate shop page. The moment of wanting is while reading.
- **Collectors of the set** — the id system creates the behaviour:
  "I have 01–07, I need 08." Numbering is the retention mechanic.
- **Gift buyers** — a sticker is a small, funny, specific gift for
  someone who follows the same news. Gift framing belongs in the
  listing copy ("for the friend who explained Kakeya to you").

Audience is Chinese-speaking, largely Singapore-based to start, with
Japanese flavour in the art. Price in **SGD** on the own site.
International buyers pay in SGD and Stripe handles the conversion
(+2% FX — the buyer bears it in the converted amount, not us).

## 4. Pricing (starting points to test)

Prices are set by two facts: the fixed S$0.50 card fee eats small
tickets alive, and a set must be an obvious bargain against singles.

| Product | Price (SGD) | Stripe card net | Stripe PayNow net |
|---|---|---|---|
| Single sticker | **S$4** | S$3.36 | S$3.95 |
| Full set (8) | **S$15** | S$13.99 | S$14.80 |
| 30-piece pack | **S$29** | S$27.51 | S$28.62 |

Fee maths (Stripe Singapore, standard plan): domestic card
3.4% + S$0.50; PayNow 1.3% flat. Worked: S$4 card = 4 − (0.14 + 0.50)
= S$3.36; PayNow = 4 − 0.05 = S$3.95. On a S$4 single, the card fee
is 16% of the price — that is why **PayNow must be offered and
promoted at checkout**, and why there is no S$2 or S$3 tier. If a
buyer insists on a card for a single sticker, the set at S$15 is the
upsell: same fixed fee, four times the value.

Physical pricing is not set until we have a print quote. As a guardrail:
a physical single must retail at **≥ S$6** and a physical set at
**≥ S$38** (print + mail + fee + margin), or it loses money. Get the
quote first, then set the price — never the other way round.

**Do not discount the singles.** Discounts live on bundles only
(set vs singles, pack vs sets). A discount on a numbered collectible
teaches buyers to wait.

## 5. Where to sell

| Channel | Role | Cost | Verdict |
|---|---|---|---|
| Own site (Stripe Payment Links) | Home, all sales to start | 3.4% + S$0.50 / PayNow 1.3% | **Phase 1** |
| Etsy | Discovery — strangers searching | ~11–14% per sale (see §7) | Phase 2 |
| Gumroad | Fallback if Stripe setup stalls | ~13% effective | Backup only |
| Instagram / X / Threads | Marketing, not checkout | Time | Link in bio → site |
| Telegram channel | Repeat buyers, new-set drops | Time | Phase 2 |

The site already has the traffic assets: share pages with OG cards
(`/share/<slug>/`), Google Analytics, likes/comments. The shop adds
one thing per sticker: a **Buy** button that opens that sticker's
Payment Link. No cart, no account — the site's no-auth ethos stays.

## 6. The buy flow (by id)

This is the flow the inventory was built for. It must work with no
human in the loop:

1. Reader opens a set, taps a sticker, sees the id
   (e.g. `kakeya-wang-hong-02`) printed on the image.
2. **Buy this sticker — S$4** button under the modal. (Set page:
   **Buy the set — S$15**.)
3. Stripe Payment Link checkout (guest checkout, no account). PayNow,
   cards, Apple Pay / Google Pay offered.
4. On success, Stripe redirects to a download page that serves the
   exact file from `inventory.json` by id, and emails the link as
   backup. The file the buyer receives is the tagged PNG — the id on
   it is the receipt.
5. Order record: Stripe payment id + sticker id + email. That is the
   whole order system for Phase 1. A spreadsheet is enough until
   volume says otherwise.

What to build for this (small, in order): Payment Links in Stripe
(one per product — 16 singles + 2 sets + 1 pack = 19 links to start,
generated from `inventory.json`); a download page that takes `?id=`
and serves the file; the Buy button in the reader modal. Nothing else.

## 7. Payments — the numbers that decide

Fees checked 2026-11-25 against the providers' own pricing pages
(via published comparisons — re-check before committing).

| Provider | Fee per sale | Monthly | Merchant of record / tax |
|---|---|---|---|
| **Stripe (SG)** | Domestic card 3.4% + S$0.50; intl card 3.9% + S$0.50; **PayNow 1.3%**; GrabPay 3.3%; Alipay/WeChat Pay 2.2% + S$0.35; Apple/Google Pay 3.4% + S$0.50; chargeback S$15 | S$0 | No — we handle GST ourselves |
| HitPay (SG) | Domestic card 2.8% + S$0.50; PayNow 0.65% + S$0.30 (≥S$100) / 0.9% min S$0.20 (<S$100); intl card 3.65% + S$0.50 | S$0 | No |
| Gumroad | 10% + $0.50 direct; **30% via Discover**; + card processing (~13% effective) | $0 | Yes — handles sales tax |
| Etsy | $0.20 listing (4 months) + 6.5% transaction + ~3% + $0.25 processing ≈ **11–14%**; offsite ads 12–15% once >$10k/yr (mandatory) | $0 | No |
| Lemon Squeezy | 5% + $0.50 | $0 | Yes |

Worked, on a **US$15** sale: Etsy keeps $1.88 (listing $0.20 +
transaction $0.98 + processing $0.70) → you keep **$13.12**. Gumroad
direct keeps $2.74 → you keep **$12.26**. Stripe on S$15 keeps S$1.01
(card) → **S$13.99**.

**Recommendation: Stripe, with PayNow front and centre.** It is the
cheapest for our price points, it is Singapore-native (PayNow is what
local buyers actually use for small amounts), and it needs no monthly
fee. HitPay is cheaper still on PayNow (0.9% vs 1.3% under S$100) —
switch to HitPay only if PayNow becomes the dominant method and the
saving exceeds the cost of running two providers; do not start with
two. Gumroad/Etsy are for reach, not for margin — never route our own
traffic through them.

**GST (Singapore):** GST registration is required once taxable
turnover exceeds **S$1m in a calendar year**. We are nowhere near
that; note it, revisit at S$500k run-rate. Prices in this plan are
GST-inclusive by default — say so on the checkout page.

**Refunds:** digital goods, delivered instantly, cannot be returned.
Policy, stated at checkout: refunds only for duplicate charges or a
corrupt file, within 7 days, manual. This is standard for digital
downloads and protects against "buy, download, refund" abuse.

**Fraud:** small tickets, instant delivery, low risk. Stripe Radar is
included at no extra cost on standard pricing. No extra fraud tooling
in Phase 1.

## 8. Marketing engine (what already exists, what to add)

What we already have — use it, don't rebuild it:

- **The column is the ad.** Every set starts as a story people want
  to read. The sticker is the souvenir of the story. Publish a set,
  the column travels, the stickers sell.
- **Share pages** (`/share/<slug>/` with OG cards) — every set has a
  linkable, previewable page. That is the social unit.
- **Numbering** — "collect the set" is the only retention mechanic a
  sticker needs. Show owned/missing ids in the reader once accounts
  exist; until then, show the id and let the buyer count.
- **GA** — currently shares the comic site's ID; split it before
  spending anything on ads, or no number will be trustworthy.

What to add, in order:

1. **Buy button in the reader modal** (Phase 1, with the Payment Links).
2. **New-set drop note** — one line at the end of each column:
   "This column became 8 stickers. [See them →]". The column is the
   launch email.
3. **Email list for drops** — a Kit form (we already run Kit for
   MyMoneyDecoder) for "new set" alerts. One email per set, no
   newsletter. This list is the highest-value asset in the plan.
4. **30-piece pack launch** — when the third set ships, the pack
   becomes the flagship product (S$29 digital). Announce it as an
   event, not a listing.
5. **Physical sample + photos** — only in Phase 3, and only with real
   photos of the real stickers (the same rule as the rest of the
   studio: no stock, no renders passed off as product).

What **not** to do: paid ads before 50 organic orders (no funnel to
optimise yet); discount codes (see §4); a subscription (nothing
recurs until sets ship on a schedule — and they don't yet); selling
on a marketplace before the own-site flow works (marketplace fees
punish a broken funnel twice).

## 9. Targets (to decide, not to promise)

No sales forecast is credible before the first 50 orders. Measure
these instead, weekly, from GA + Stripe:

| Metric | First target |
|---|---|
| Reader → Buy-button click | 2% of set-page views |
| Checkout completion | 60% of clicks |
| PayNow share of payments | >50% (it is the cheapest) |
| Repeat buyer (2nd set) | 15% within 60 days |
| Orders to first S$1,000 revenue | ~70 orders at current mix |

Break-even on effort, not on cash: Phase 1 costs ~S$0 to run
(no monthly fees anywhere). The cost is the build time for the Buy
button + download page. If 50 orders don't arrive in 60 days, the
problem is traffic, not price — fix the column distribution first.

## 10. Risks

- **Column rights.** The stickers illustrate columns. If a column is
  not ours (supplied by a third party, or summarising someone else's
  reporting), selling merchandise from it needs that party's
  agreement. Our own columns: no issue. Check before each set ships.
- **AI disclosure on Etsy.** Etsy requires AI-assisted items to be
  categorised and disclosed in the listing. Our stickers are AI-drawn
  — disclose it plainly in Phase 2 listings; hiding it risks the shop.
- **The PNG can be reshared.** Digital stickers leak. Accept it: the
  price buys convenience, the story, and the numbered file — not
  exclusivity. Physical stickers are the scarce product, if scarcity
  is ever needed.
- **Print quality (Phase 3).** Colours shift, die-cut borders move.
  Never sell physical before holding a sample in hand.
- **Cache staleness.** The site caches sticker images (SW + HTTP,
  up to 1 day). A buyer must never pay for one file and receive an
  older version — the download page must serve by id from the
  current `inventory.json`, not from a cached image URL.

## 11. Decisions needed from the user

1. **Digital-first, yes or no?** (Recommendation: yes.)
2. **Prices:** S$4 / S$15 / S$29 — approve, or change.
3. **Stripe account:** create one (business details needed) and
   enable PayNow — or use HitPay instead.
4. **Physical:** in scope for later, or never?
5. **Etsy:** Phase 2, or skip marketplaces entirely?

## 12. Launch checklist (Phase 1)

- [ ] Approve prices (§4) and the digital-first call (§11).
- [ ] Create Stripe account, enable PayNow + cards + Apple/Google Pay.
- [ ] Generate Payment Links from `inventory.json` (19 links: 16 singles,
      2 sets, 1 pack placeholder until the third set ships).
- [ ] Build the download page (`?id=<slug>-NN` → tagged PNG + email backup).
- [ ] Add the Buy button to the reader modal + set page.
- [ ] Write the refund line into checkout copy (§7).
- [ ] Split GA into its own property for Sutekka.
- [ ] Kit form for new-set drop alerts.
- [ ] Ship, then read the §9 metrics weekly for 60 days before
      spending anything on ads or physical stock.

---

## Sources (fees, checked 2026-11-25)

- Stripe Singapore pricing — domestic card 3.4% + S$0.50, intl 3.9% +
  S$0.50, PayNow 1.3%, GrabPay 3.3%, Alipay/WeChat Pay 2.2% + S$0.35,
  chargeback S$15, no monthly fee:
  <https://stripe.com/en-sg/pricing> (via
  <https://www.worldfirst.com/sg/blog/international-transactions/stripe-fees-singapore/>
  and <https://www.airwallex.com/en-sg/blog/stripe-review>)
- HitPay vs Stripe Singapore (checked 16 Nov 2026) — HitPay domestic
  card 2.8% + S$0.50, PayNow 0.65% + S$0.30 (≥S$100):
  <https://hitpayapp.com/sg/hitpay-vs-stripe>
- Gumroad vs Etsy vs Stan Store (checked 8 Nov 2026) — Gumroad 10% +
  $0.50 direct, 30% Discover; Etsy $0.20 listing + 6.5% + 3% + $0.25;
  worked US$15 example ($13.12 Etsy / $12.26 Gumroad kept):
  <https://sidehustleradar.com/learn/gumroad-vs-etsy-vs-stan-store/>
- Lemon Squeezy 5% + $0.50, merchant of record; Payhip 5% free plan:
  <https://www.panstag.com/2026/05/best-platforms-sell-digital-products.html>

Fees change. Re-check every number against the provider's own page
before creating accounts or setting prices.
