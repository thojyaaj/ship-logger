// See lib/shopify.ts for why this doesn't import "server-only" — same
// reason: it's also used by standalone scripts run via bare tsx.
import { db } from "./db";
import { shopifyOrderIndex, scan } from "./db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { nowSqlTimestamp } from "./date";
import type { OrderSummary } from "./shopify";

/**
 * Upserts one row per tracking number into the local index (§9b), then
 * immediately backfills any already-scanned UPS/DHL rows in `scan` that
 * were sitting there un-enriched (scanned before the fulfillment webhook
 * arrived, or before Phase 2 existed at all).
 */
export async function upsertOrderIndex(
  trackingNumbers: string[],
  order: OrderSummary,
): Promise<void> {
  if (trackingNumbers.length === 0) return;
  const now = nowSqlTimestamp();

  for (const trackingNumber of trackingNumbers) {
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
    .where(inArray(scan.trackingNumber, trackingNumbers));
}

/** Local, no-network lookup used at scan time (§9c) and on shipment detail pages. */
export async function lookupOrderIndex(
  trackingNumber: string,
): Promise<{ orderGid: string; orderName: string } | null> {
  const rows = await db
    .select({ orderGid: shopifyOrderIndex.orderGid, orderName: shopifyOrderIndex.orderName })
    .from(shopifyOrderIndex)
    .where(eq(shopifyOrderIndex.trackingNumber, trackingNumber))
    .limit(1);
  return rows[0] ?? null;
}

export async function orderIndexSize(): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(shopifyOrderIndex);
  return rows[0]?.count ?? 0;
}
