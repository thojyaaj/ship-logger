// See lib/shopify.ts for why this doesn't import "server-only" — same
// reason: it's also used by standalone scripts run via bare tsx.
import { db } from "./db";
import { shopifyOrderIndex, scan } from "./db/schema";
import { eq, inArray } from "drizzle-orm";
import { nowSqlTimestamp } from "./date";
import { normalizeTrackingNumber } from "./carrier";
import type { OrderSummary } from "./shopify";

/**
 * Upserts one row per tracking number into the local index (§9b), then
 * immediately backfills any already-scanned UPS/DHL rows in `scan` that
 * were sitting there un-enriched (scanned before the fulfillment webhook
 * arrived, or before Phase 2 existed at all).
 *
 * Normalizes every tracking number the same way scan-time detection does
 * (lib/carrier.ts) before storing or matching against `scan` — Shopify's
 * fulfillment payload carries tracking numbers as whatever the courier API
 * or a human typed, not necessarily trimmed/uppercased. Comparing that
 * as-is against a normalized `scan.tracking_number` is an exact-match miss
 * waiting to happen.
 */
export async function upsertOrderIndex(
  trackingNumbers: string[],
  order: OrderSummary,
): Promise<void> {
  if (trackingNumbers.length === 0) return;
  const normalized = trackingNumbers.map(normalizeTrackingNumber);
  const now = nowSqlTimestamp();

  for (const trackingNumber of normalized) {
    await db
      .insert(shopifyOrderIndex)
      .values({
        trackingNumber,
        orderGid: order.gid,
        orderName: order.name,
        customerName: order.customerName,
        destination: order.destination,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: shopifyOrderIndex.trackingNumber,
        set: {
          orderGid: order.gid,
          orderName: order.name,
          customerName: order.customerName,
          destination: order.destination,
          updatedAt: now,
        },
      });
  }

  await db
    .update(scan)
    .set({ orderGid: order.gid, orderName: order.name })
    .where(inArray(scan.trackingNumber, normalized));
}

/** Local, no-network lookup used at scan time (§9c) and on shipment detail pages. */
export async function lookupOrderIndex(
  trackingNumber: string,
): Promise<{ orderGid: string; orderName: string } | null> {
  const rows = await db
    .select({ orderGid: shopifyOrderIndex.orderGid, orderName: shopifyOrderIndex.orderName })
    .from(shopifyOrderIndex)
    .where(eq(shopifyOrderIndex.trackingNumber, normalizeTrackingNumber(trackingNumber)))
    .limit(1);
  return rows[0] ?? null;
}
