/**
 * Finds a Shopify variant's real SKU by product title — useful when a
 * Fruugo order's SKU doesn't match what's actually in Shopify (different
 * SKU scheme, or a marketplace-side id) and you need to find the right one
 * to put in a Fruugo import JSON file (see import-fruugo-order.ts).
 *
 * Usage: npx tsx scripts/search-product.ts "search terms"
 */
process.loadEnvFile?.(".env.local");

import { searchVariantsByTitle } from "../lib/shopify";

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error('Usage: npx tsx scripts/search-product.ts "search terms"');
  process.exit(1);
}

async function main() {
  const matches = await searchVariantsByTitle(query);
  if (matches.length === 0) {
    console.log(`No variants found matching "${query}".`);
    process.exit(0);
  }
  console.log(`${matches.length} match(es) for "${query}":\n`);
  for (const m of matches) {
    console.log(`  SKU: ${m.sku || "(none)"}  —  ${m.title}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
