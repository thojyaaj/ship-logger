/**
 * Creates a Shopify order from a Fruugo order transcribed into JSON — Fruugo
 * has no order API/export we integrate with, so the source of truth is
 * whatever a human (or Claude, reading a screenshot) typed into the file.
 * That's also why this is a separate manual step rather than something that
 * runs unattended: garbage in here becomes a real paid order with real
 * inventory decremented.
 *
 * Usage:
 *   npx tsx scripts/import-fruugo-order.ts path/to/order.json [--dry-run]
 *
 * --dry-run resolves every line item to a variant and prints what WOULD be
 * created, without calling orderCreate. Always run with --dry-run first.
 *
 * Line items are matched by PRODUCT TITLE, not SKU — Fruugo's SKUs don't
 * correspond to anything in this store's catalog (see the "sku" field's own
 * comment), so a SKU-based lookup would just fail on every single order.
 * Title search only auto-resolves when it's unambiguous: exactly one
 * catalog match, or exactly one *exact* title match among several loose
 * ones. Anything else stops and lists the candidates rather than guessing —
 * a wrong guess here is a real order for the wrong product.
 *
 * See scripts/fruugo-order.example.json for the expected shape.
 *
 * Requires SHOPIFY_STORE / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET with
 * read_products + write_orders scopes approved, PLUS a one-time OAuth
 * install for order creation specifically — see README's "Creating orders
 * via the API" section.
 */
process.loadEnvFile?.(".env.local");

import { readFileSync } from "node:fs";
import { createOrder, searchVariantsByTitle } from "../lib/shopify";

type FruugoOrderFile = {
  fruugoOrderNumber: string;
  customerEmail?: string;
  currency: string;
  shippingAddress: {
    firstName?: string;
    lastName?: string;
    address1: string;
    address2?: string;
    city: string;
    province?: string;
    zip: string;
    countryCode: string;
    phone?: string;
  };
  lineItems: {
    title: string;
    quantity: number;
    price: string;
    // Fruugo's own SKU, if shown on the order — recorded in the order note
    // for reconciliation only, never used to look up the Shopify variant
    // (Fruugo's SKUs have been changed and no longer match this catalog).
    fruugoSku?: string;
  }[];
  shipping?: { title?: string; price: string };
};

const filePath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!filePath) {
  console.error("Usage: npx tsx scripts/import-fruugo-order.ts path/to/order.json [--dry-run]");
  process.exit(1);
}

function validate(raw: unknown): FruugoOrderFile {
  const errors: string[] = [];
  const o = raw as Partial<FruugoOrderFile>;

  if (!o.fruugoOrderNumber) errors.push("fruugoOrderNumber is required");
  if (!o.currency) errors.push("currency is required");
  if (!o.shippingAddress?.address1) errors.push("shippingAddress.address1 is required");
  if (!o.shippingAddress?.city) errors.push("shippingAddress.city is required");
  if (!o.shippingAddress?.zip) errors.push("shippingAddress.zip is required");
  if (!o.shippingAddress?.countryCode) errors.push("shippingAddress.countryCode is required");
  if (!o.lineItems?.length) errors.push("lineItems must have at least one item");
  o.lineItems?.forEach((li, i) => {
    if (!li.title) errors.push(`lineItems[${i}].title is required`);
    if (!li.quantity || li.quantity < 1) errors.push(`lineItems[${i}].quantity must be >= 1`);
    if (!li.price) errors.push(`lineItems[${i}].price is required`);
  });

  if (errors.length > 0) {
    throw new Error(`Invalid order file:\n  - ${errors.join("\n  - ")}`);
  }
  return o as FruugoOrderFile;
}

type ResolveResult =
  | { status: "resolved"; gid: string; title: string; sku: string; matchedOn: string }
  | { status: "ambiguous"; candidates: { title: string; sku: string }[]; matchedOn: string }
  | { status: "not_found" };

/**
 * Fruugo's product name and this store's Shopify title are almost never
 * word-for-word identical (different unit notation, extra descriptors, a
 * different word order) — searchVariantsByTitle ANDs every word as a
 * trailing-wildcard clause, so requiring the FULL title to match is too
 * strict and returns nothing even when the product obviously exists (this
 * is what happened live: all six line items in a batch came back "no
 * match" on their full titles).
 *
 * So this tries the full title first, then progressively drops trailing
 * words (the ones most likely to be size/count/color descriptors that
 * differ between the two listings) and retries, stopping at the first
 * query length that returns exactly one candidate — or, among several,
 * exactly one whose title exactly equals the *original* full title. Still
 * refuses to guess: a query that comes back with 2+ candidates and no
 * exact match is reported ambiguous rather than picked from, and a query
 * that never returns anything down to a single word is not_found.
 */
// Shopify's displayName is "<product title> - <variant title>", and almost
// every variant in this catalog is the lone "Default Title" one — so a
// candidate's displayName almost never equals a transcribed Fruugo title
// verbatim even for a perfect match. Stripping that specific suffix before
// comparing is what makes the exact-match fallback below actually fire
// instead of silently never matching (caught live: "Crystal Light...
// Lemonade" vs "...Raspberry Lemonade" stayed "ambiguous" even when the
// order file's title was copied character-for-character from the correct
// candidate's own displayName).
function stripDefaultTitleSuffix(displayName: string): string {
  return displayName.replace(/\s*-\s*default title\s*$/i, "").trim();
}

async function resolveByTitle(title: string): Promise<ResolveResult> {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const normalizedFull = title.trim().toLowerCase();

  for (let n = words.length; n >= 1; n--) {
    const query = words.slice(0, n).join(" ");
    const candidates = await searchVariantsByTitle(query);
    if (candidates.length === 0) continue;

    if (candidates.length === 1) {
      const c = candidates[0];
      return { status: "resolved", gid: c.gid, title: c.title, sku: c.sku, matchedOn: query };
    }

    const exactMatches = candidates.filter(
      (c) => stripDefaultTitleSuffix(c.title).toLowerCase() === normalizedFull,
    );
    if (exactMatches.length === 1) {
      const c = exactMatches[0];
      return { status: "resolved", gid: c.gid, title: c.title, sku: c.sku, matchedOn: query };
    }

    return { status: "ambiguous", candidates, matchedOn: query };
  }

  return { status: "not_found" };
}

async function main() {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  const order = validate(raw);

  console.log(`Fruugo order ${order.fruugoOrderNumber} — resolving ${order.lineItems.length} line item(s) by title...`);

  const resolvedLineItems = [];
  let hadFailure = false;
  for (const li of order.lineItems) {
    const result = await resolveByTitle(li.title);
    if (result.status === "resolved") {
      const viaNote = result.matchedOn.toLowerCase() !== li.title.trim().toLowerCase() ? ` [matched via "${result.matchedOn}"]` : "";
      console.log(`  "${li.title}" -> ${result.title} (${result.sku}) x${li.quantity} @ ${li.price}${viaNote}`);
      resolvedLineItems.push({ variantGid: result.gid, quantity: li.quantity, priceAmount: li.price });
    } else if (result.status === "not_found") {
      hadFailure = true;
      console.error(`  "${li.title}" -> NO MATCH in Shopify catalog`);
    } else {
      hadFailure = true;
      console.error(`  "${li.title}" -> AMBIGUOUS on search "${result.matchedOn}", ${result.candidates.length} candidates:`);
      for (const c of result.candidates) {
        console.error(`      ${c.sku || "(no sku)"} — ${c.title}`);
      }
    }
  }

  if (hadFailure) {
    console.error("\nFix lineItems[].title in the order file to match the catalog exactly and re-run.");
    process.exit(1);
  }

  if (order.shipping) {
    console.log(`  Shipping: ${order.shipping.title ?? "Standard Shipping"} @ ${order.shipping.price}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no order created. Re-run without --dry-run to create it in Shopify.");
    process.exit(0);
  }

  const fruugoSkuNote = order.lineItems
    .filter((li) => li.fruugoSku)
    .map((li) => `${li.title}: ${li.fruugoSku}`)
    .join("; ");

  const created = await createOrder({
    email: order.customerEmail,
    note: `Imported from Fruugo order ${order.fruugoOrderNumber}` + (fruugoSkuNote ? ` (Fruugo SKUs — ${fruugoSkuNote})` : ""),
    tags: ["fruugo", "imported"],
    currency: order.currency,
    lineItems: resolvedLineItems,
    shippingLine: order.shipping
      ? { title: order.shipping.title ?? "Standard Shipping", priceAmount: order.shipping.price }
      : undefined,
    shippingAddress: order.shippingAddress,
  });

  console.log(`\nCreated ${created.name}: ${created.adminUrl}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
