#!/usr/bin/env python3
"""Create the Sutekka shop's Stripe Products, Prices and Payment Links.

Reads web_app/data/inventory.json + web_app/data/index.json and creates,
in the Stripe account the custom.stripe connector points at (the Gobblemon
sandbox while the stored key is a test key):

  - 40 single stickers at S$4 each
  - 5 sets (8 stickers each) at S$15 each
  - 1 complete pack (first 30 stickers in inventory order) at S$29

Each Product/Price/Payment Link carries metadata shop_item=<item id> and
shop_type=single|set|pack, so the webhook can map a payment back to the
exact file(s). The script is idempotent: it lists existing Products,
Prices and Payment Links first and reuses any that already match, so it
is safe to re-run after a partial failure.

Outputs (both generated, both checked in):
  - web_app/data/payment-links.json — the shop's link map, read by app.js
    for the Buy buttons and the download page.
  - api/_lib/payment-link-map.js — link id -> item, used by the webhook
    as a fallback when the Checkout Session carries no metadata.

Runs on this VM only: it authenticates through the custom.stripe
connector (dynamic_credentials surrogate exchange); the key itself never
appears here, in arguments, or in output.

Usage:
  python3 scripts/create_stripe_links.py
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import (
    add_surrogate_to_request,
    read_json_response,
)

REPO = __file__.rsplit("/scripts/", 1)[0]
BASE = "https://api.stripe.com"
CREDENTIAL_NAME = "custom.stripe"
ALLOWED_HOSTS = ["api.stripe.com"]
CURRENCY = "sgd"
SINGLE_PRICE = 400   # S$4
SET_PRICE = 1500     # S$15
PACK_PRICE = 2900    # S$29
PACK_SIZE = 30
DOWNLOAD_URL = (
    "https://sutekka.gobblemon.com/#/download?session_id={CHECKOUT_SESSION_ID}"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def stripe(method, path, payload=None):
    """One Stripe API call. payload is flat form keys (bracket notation
    for nesting, e.g. metadata[shop_item]). Returns the parsed JSON."""
    url = BASE + path
    data = None
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if method == "POST":
        data = urllib.parse.urlencode(payload or {}, doseq=True).encode()
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    add_surrogate_to_request(request, CREDENTIAL_NAME, allowed_hosts=ALLOWED_HOSTS)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as r:
            return read_json_response(r)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Stripe {method} {path} -> HTTP {exc.code}: {body}")


def build_items():
    inventory = json.load(open(f"{REPO}/web_app/data/inventory.json"))
    index = json.load(open(f"{REPO}/web_app/data/index.json"))
    stickers = inventory["stickers"]
    sets = index["sets"]
    items = []
    for s in stickers:
        items.append({
            "item_id": s["id"],
            "type": "single",
            "title": f"{s['set_title']} — {s['title']} (#{s['n']})",
            "amount": SINGLE_PRICE,
            "set_slug": s["set_slug"],
            "stickers": [s["id"]],
        })
    for st in sets:
        items.append({
            "item_id": st["slug"],
            "type": "set",
            "title": f"{st['title']} — full set (8 stickers)",
            "amount": SET_PRICE,
            "set_slug": st["slug"],
            "stickers": [x["id"] for x in st["stickers"]],
        })
    pack_ids = [s["id"] for s in stickers[:PACK_SIZE]]
    items.append({
        "item_id": "complete-pack-30",
        "type": "pack",
        "title": "Sutekka Complete Pack — 30 stickers",
        "amount": PACK_PRICE,
        "set_slug": None,
        "stickers": pack_ids,
    })
    return items


def main():
    items = build_items()
    print(f"{len(items)} items: 40 singles + 5 sets + 1 pack")

    products = stripe("GET", "/v1/products?limit=100&active=true")["data"]
    by_item = {}
    for p in products:
        key = (p.get("metadata") or {}).get("shop_item")
        if key:
            by_item[key] = p["id"]
    print(f"existing shop products: {len(by_item)}")

    links = stripe("GET", "/v1/payment_links?limit=100&active=true")["data"]
    link_by_item = {}
    for ln in links:
        key = (ln.get("metadata") or {}).get("shop_item")
        if key:
            link_by_item[key] = {"id": ln["id"], "url": ln["url"]}
    print(f"existing shop payment links: {len(link_by_item)}")

    out = {"generated_by": "scripts/create_stripe_links.py",
           "currency": CURRENCY, "download_url": DOWNLOAD_URL,
           "singles": {}, "sets": {}, "pack": None}
    link_map = {}
    created = {"products": 0, "prices": 0, "links": 0}
    warnings = []

    for item in items:
        iid, itype = item["item_id"], item["type"]
        product_id = by_item.get(iid)
        if not product_id:
            p = stripe("POST", "/v1/products", {
                "name": item["title"][:250],
                "description": ("Digital sticker PNG download. "
                                "One-time purchase; no subscription."),
                "metadata[shop_item]": iid,
                "metadata[shop_type]": itype,
            })
            product_id = p["id"]
            created["products"] += 1
            time.sleep(0.1)

        prices = stripe("GET", f"/v1/prices?product={product_id}&limit=10")["data"]
        price = next((x for x in prices
                      if x.get("active") and x.get("unit_amount") == item["amount"]
                      and x.get("currency") == CURRENCY), None)
        if not price:
            price = stripe("POST", "/v1/prices", {
                "currency": CURRENCY,
                "unit_amount": item["amount"],
                "product": product_id,
                "metadata[shop_item]": iid,
                "metadata[shop_type]": itype,
            })
            created["prices"] += 1
            time.sleep(0.1)

        link = link_by_item.get(iid)
        if not link:
            payload = {
                "line_items[0][price]": price["id"],
                "line_items[0][quantity]": "1",
                "metadata[shop_item]": iid,
                "metadata[shop_type]": itype,
                "after_completion[type]": "redirect",
                "after_completion[redirect][url]": DOWNLOAD_URL,
            }
            try:
                payload["automatic_tax[enabled]"] = "true"
                ln = stripe("POST", "/v1/payment_links", payload)
            except RuntimeError as e:
                # Stripe Tax may not be enabled on the account; the link
                # itself is still valid without automatic tax.
                warnings.append(f"{iid}: automatic_tax rejected ({e}); "
                                "created link without it")
                del payload["automatic_tax[enabled]"]
                ln = stripe("POST", "/v1/payment_links", payload)
            link = {"id": ln["id"], "url": ln["url"]}
            created["links"] += 1
            time.sleep(0.1)

        entry = {
            "item_id": iid,
            "type": itype,
            "title": item["title"],
            "amount": item["amount"],
            "product_id": product_id,
            "price_id": price["id"],
            "link_id": link["id"],
            "url": link["url"],
            "stickers": item["stickers"],
        }
        if itype == "single":
            entry["set_slug"] = item["set_slug"]
            out["singles"][iid] = entry
        elif itype == "set":
            entry["set_slug"] = item["set_slug"]
            out["sets"][iid] = entry
        else:
            out["pack"] = entry
        link_map[link["id"]] = {"itemId": iid, "type": itype,
                                "amount": item["amount"]}

    with open(f"{REPO}/web_app/data/payment-links.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    with open(f"{REPO}/api/_lib/payment-link-map.js", "w") as f:
        f.write("// Generated by scripts/create_stripe_links.py — do not hand-edit.\n"
                "// Payment Link id -> shop item, used by the Stripe webhook as a\n"
                "// fallback when the Checkout Session carries no metadata.\n"
                "\"use strict\";\n\nmodule.exports = ")
        f.write(json.dumps(link_map, indent=2))
        f.write(";\n")

    print(f"created: {created}")
    for w in warnings:
        print("WARNING:", w)
    print(f"wrote web_app/data/payment-links.json "
          f"({len(out['singles'])} singles, {len(out['sets'])} sets, pack)")
    print(f"wrote api/_lib/payment-link-map.js ({len(link_map)} links)")


if __name__ == "__main__":
    main()
