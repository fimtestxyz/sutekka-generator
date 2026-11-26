# Stripe implementation plan — Gobblemon.com (Sutekka shop)

Generated 2026-11-26 with Stripe's official implementation planner
(`stripe tools plan`, CLI 1.55.15, OAuth session on the Gobblemon sandbox
account acct_1Ufu7F2KboBtXa6r). The CLI path does not expose the planner's
accept callback, so the decision tree below was walked by hand against the
business context and the plan was finalised by evaluation, not by a server
accept confirmation. Guide draft: iguide_61VpSRlFlBiNwPHxl412KboBtXa6r.

## Business context used

- Gobblemon.com sells digital art: sticker sets made from current-affairs
  columns. 40 individual digital stickers, 5 sets of 8, one 30-piece pack.
- One-time purchases only, no subscriptions.
- Prices in SGD: S$4 single sticker, S$15 set, S$29 pack.
- Singapore business and buyers; PayNow matters.
- Stack: static vanilla-JS site on Vercel, serverless functions, Neon
  Postgres (Prisma). No Stripe integration exists yet.
- Planned shape: Stripe Payment Links per product, a download page serving
  the PNG by sticker id after payment, an Order table with a Stripe webhook
  for tracked orders. Guest checkout, no accounts required to buy.

## Decision path walked

1. Another processor alongside Stripe? **No, Stripe only.**
2. How do you primarily accept payments? **In a web browser.**
3. Managed Payments (Stripe handles tax, fraud, compliance)?
   **No — standard path.** See the alternative below.
4. Send invoices to customers as the primary flow? **No, standard checkout.**
5. One-time payment links without a custom checkout page?
   **Yes, shareable payment links.**

## Recommended setup (phase 1)

- **Payments: Payment Links, 46 of them.** 40 singles at S$4, 5 sets at
  S$15, 1 pack at S$29. One Product + one Price per item, or one Price per
  item under a small set of Products. The sticker id (`<slug>-NN`) goes in
  the Price/Product metadata so the webhook can map a payment to the exact
  file. Buy buttons in the sticker modal and on the set page point at the
  link URL for that item.
- **Checkout features to enable (planner principles):** Link, Dynamic
  Payment Methods, Adaptive Pricing. PayNow front and centre for Singapore
  buyers; cards alongside it.
- **Success URL:** the download page, with `{CHECKOUT_SESSION_ID}` in the
  URL. The page looks the session up server-side, confirms payment, then
  shows the download link for the exact PNG by id, plus the link by email.
- **Tax: Stripe Tax on the Payment Links.** At current volume the business
  is below Singapore's S$1m GST registration threshold, so there is no GST
  to charge on local sales today; Stripe Tax keeps the record straight and
  covers overseas buyers' digital-goods tax where it applies.
- **Invoicing: receipts automatic, invoices on request.** Payment Links
  send the buyer a receipt automatically. Use Hosted Invoices (API) only
  for buyers who ask for a formal invoice.
- **Orders (tracked):** an Order table in Neon (Prisma) + a Stripe webhook
  endpoint. The webhook records each paid session as an order
  (paid → delivered) with the Stripe payment id, sticker id and buyer
  email. The buyer looks an order up by order id or email.
- **Connect: not needed for phase 1.** Connect exists to pay out third
  parties. The shop sells the business's own stickers, so there is nobody
  to pay out. Revisit only if the shop starts paying column authors or
  artists per sale.
- **Fees (Stripe SG, from the earlier rate check):** domestic card 3.4% +
  S$0.50, PayNow 1.3%, international card 3.9% + S$0.50. No monthly fee.

## Alternative considered: Managed Payments

- Stripe becomes the merchant of record and handles sales tax/VAT/GST,
  fraud and disputes. Singapore businesses are eligible, digital images
  are an eligible product, and it works with Payment Links.
- It costs **3.5% per transaction on top of** normal processing fees, needs
  a Stripe eligibility review, does **not** deliver files or licence keys
  (the download page is still ours to build), and is **incompatible** with
  marketplace/Connect sales.
- Recommendation: **not now.** At S$4–29 per sale the 3.5% is real money
  on every order, while the tax it would handle is near zero at current
  volume (below the S$1m GST threshold). Revisit when volume grows or
  cross-border tax gets complicated.

## Review of the existing integration

- There is none. The repo has no Stripe code, no Order model and no Stripe
  calls anywhere (checked 2026-11-26). Everything in this plan is
  greenfield. The pieces it builds on already exist: the 40 sticker SKUs
  in `web_app/data/inventory.json`, the Neon database with Prisma, and the
  Vercel serverless functions under `api/`.

## Open decisions

1. Managed Payments now or later (recommendation: later, see above).
2. Live account onboarding: the sandbox account has not submitted business
   details and charges/payouts are disabled. Real money needs the full
   account setup (business details, bank account, ID check) plus PayNow
   enabled in the Dashboard.
3. Column-rights check per set before selling (from MONETISE.md).
4. Physical stickers stay out of scope until a print sample exists.

## Sources

- Planner decision tree (Stripe CLI `stripe tools plan`, 2026-11-26).
- Payment Links docs: https://docs.stripe.com/payment-links/create?pricing-model=standard
- Managed Payments eligibility and fees: Stripe docs via third-party
  summaries, checked 2026-11-26 (Singapore eligible, digital images
  eligible, +3.5% per transaction, no file delivery, no marketplace sales).
- Stripe Tax and Invoicing docs as linked from the planner output.
