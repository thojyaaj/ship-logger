/**
 * §9b step 2 — one-time backfill of the local order index from existing
 * Shopify order/fulfillment history, so tracking numbers scanned before
 * Phase 2 shipped (or before a webhook fired) still resolve to an order.
 *
 * Usage: npx tsx scripts/backfill-orders.ts [--days 180]
 */
process.loadEnvFile?.(".env.local");

import { shopifyGraphql } from "../lib/shopify";
import { upsertOrderIndex } from "../lib/order-index";

const daysArgIndex = process.argv.indexOf("--days");
const LOOKBACK_DAYS = daysArgIndex >= 0 ? Number(process.argv[daysArgIndex + 1]) : 180;
const PAGE_SIZE = 50;

type OrdersPage = {
  orders: {
    edges: {
      node: {
        id: string;
        name: string;
        shippingAddress: { formatted: string[] } | null;
        fulfillments: { trackingInfo: { number: string | null }[] }[];
      };
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const QUERY = `
  query($cursor: String, $search: String!) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $search, sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          shippingAddress { formatted }
          fulfillments(first: 10) {
            trackingInfo { number }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function main() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const search = `created_at:>=${since.toISOString().slice(0, 10)} fulfillment_status:partial OR fulfillment_status:fulfilled`;

  let cursor: string | null = null;
  let pages = 0;
  let ordersSeen = 0;
  let trackingNumbersIndexed = 0;

  do {
    const data: OrdersPage = await shopifyGraphql<OrdersPage>(QUERY, { cursor, search });
    pages += 1;

    for (const { node } of data.orders.edges) {
      ordersSeen += 1;
      const numbers = node.fulfillments
        .flatMap((f) => f.trackingInfo)
        .map((t) => t.number)
        .filter((n): n is string => !!n);
      if (numbers.length === 0) continue;

      await upsertOrderIndex(numbers, {
        gid: node.id,
        name: node.name,
        // Always null — read_customers wasn't part of §9's scope request; see lib/shopify.ts.
        customerName: null,
        destination: node.shippingAddress?.formatted.join(", ") ?? null,
      });
      trackingNumbersIndexed += numbers.length;
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    console.log(`page ${pages}: ${ordersSeen} orders seen, ${trackingNumbersIndexed} tracking numbers indexed so far`);
  } while (cursor);

  console.log(`Done. ${ordersSeen} orders scanned, ${trackingNumbersIndexed} tracking numbers indexed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
