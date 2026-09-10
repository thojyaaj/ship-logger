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
 * --dry-run resolves every SKU to a variant and prints what WOULD be
 * created, without calling orderCreate. Always run with --dry-run first.
 *
 * See scripts/fruugo-order.example.json for the expected shape.
 *
 * Requires SHOPIFY_STORE / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET with
 * read_products + write_orders scopes approved (read_orders/read_all_orders/
 * read_fulfillments alone, as configured for the rest of this app, are not
 * enough — see lib/shopify.ts).
 */
process.loadEnvFile?.(".env.local");

import { readFileSync } from "node:fs";
import { createOrder, findVariantBySku } from "../lib/shopify";

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
  lineItems: { sku: string; quantity: number; price: string }[];
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
    if (!li.sku) errors.push(`lineItems[${i}].sku is required`);
    if (!li.quantity || li.quantity < 1) errors.push(`lineItems[${i}].quantity must be >= 1`);
    if (!li.price) errors.push(`lineItems[${i}].price is required`);
  });

  if (errors.length > 0) {
    throw new Error(`Invalid order file:\n  - ${errors.join("\n  - ")}`);
  }
  return o as FruugoOrderFile;
}

async function main() {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  const order = validate(raw);

  console.log(`Fruugo order ${order.fruugoOrderNumber} — resolving ${order.lineItems.length} line item(s)...`);

  const resolvedLineItems = [];
  const unresolvedSkus: string[] = [];
  for (const li of order.lineItems) {
    const variant = await findVariantBySku(li.sku);
    if (!variant) {
      unresolvedSkus.push(li.sku);
      continue;
    }
    console.log(`  ${li.sku} -> ${variant.title} x${li.quantity} @ ${li.price}`);
    resolvedLineItems.push({ variantGid: variant.gid, quantity: li.quantity, priceAmount: li.price });
  }

  if (unresolvedSkus.length > 0) {
    console.error(`\nNo Shopify variant found for SKU(s): ${unresolvedSkus.join(", ")}`);
    console.error("Fix the SKU in the order file (or create/publish the variant in Shopify) and re-run.");
    process.exit(1);
  }

  if (order.shipping) {
    console.log(`  Shipping: ${order.shipping.title ?? "Standard Shipping"} @ ${order.shipping.price}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no order created. Re-run without --dry-run to create it in Shopify.");
    process.exit(0);
  }

  const created = await createOrder({
    email: order.customerEmail,
    note: `Imported from Fruugo order ${order.fruugoOrderNumber}`,
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
