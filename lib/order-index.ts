// See lib/shopify.ts for why this doesn't import "server-only" — same
// reason: it's also used by standalone scripts run via bare tsx.
import { db } from "./db";
import { shopifyOrderIndex, scan } from "./db/schema";
import { eq, inArray, and, or, isNotNull, isNull } from "drizzle-orm";
import { nowSqlTimestamp } from "./date";
import { normalizeTrackingNumber } from "./carrier";
import { getOrderSummary, type OrderSummary } from "./shopify";

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
        destinationCountry: order.destinationCountry,
        customerShippingAmount: order.customerShippingAmount,
        customerShippingCurrency: order.customerShippingCurrency,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: shopifyOrderIndex.trackingNumber,
        set: {
          orderGid: order.gid,
          orderName: order.name,
          customerName: order.customerName,
          destination: order.destination,
          destinationCountry: order.destinationCountry,
          customerShippingAmount: order.customerShippingAmount,
          customerShippingCurrency: order.customerShippingCurrency,
          updatedAt: now,
        },
      });
  }

  await db
    .update(scan)
    .set({
      orderGid: order.gid,
      orderName: order.name,
      destinationCountry: order.destinationCountry,
      customerShippingAmount: order.customerShippingAmount,
      customerShippingCurrency: order.customerShippingCurrency,
    })
    .where(inArray(scan.trackingNumber, normalized));
}

/** Local, no-network lookup used at scan time (§9c) and on shipment detail pages. */
export async function lookupOrderIndex(trackingNumber: string): Promise<{
  orderGid: string;
  orderName: string;
  destinationCountry: string | null;
  customerShippingAmount: number | null;
  customerShippingCurrency: string | null;
} | null> {
  const rows = await db
    .select({
      orderGid: shopifyOrderIndex.orderGid,
      orderName: shopifyOrderIndex.orderName,
      destinationCountry: shopifyOrderIndex.destinationCountry,
      customerShippingAmount: shopifyOrderIndex.customerShippingAmount,
      customerShippingCurrency: shopifyOrderIndex.customerShippingCurrency,
    })
    .from(shopifyOrderIndex)
    .where(eq(shopifyOrderIndex.trackingNumber, normalizeTrackingNumber(trackingNumber)))
    .limit(1);
  return rows[0] ?? null;
}

// One click's worth of order lookups — each is a single Shopify GraphQL call
// (getOrderSummary, by id), so this is a time/quota budget, not a rate limit
// like DHL's tracking API. Admin can just click again if a backlog is bigger
// than this; matches this app's existing "bounded per run, resumable across
// runs" convention (see lib/dhl-status-cron.ts) even though this one's
// triggered by a click, not a cron.
const MAX_ORDERS_PER_BACKFILL_RUN = 40;

export type BackfillCountriesResult = {
  /** Distinct already-matched orders still missing a country or a charged-shipping amount, before this run. */
  candidates: number;
  processed: number;
  updated: number;
  errors: number;
};

/**
 * Fills in `destinationCountry` (and, as of the shipping-cost-vs-charged
 * comparison, `customerShippingAmount`/`customerShippingCurrency` too — same
 * upsertOrderIndex call, so any field it writes gets backfilled here for
 * free) for scans that already had an order matched *before* those fields
 * existed — `upsertOrderIndex`'s scan update only runs when a matching order
 * is (re-)resolved, so a scan matched in the past and never touched since
 * stays permanently null otherwise. Reuses the exact same write path as
 * every other order match (getOrderSummary + upsertOrderIndex) rather than a
 * separate one-off lookup, so there is only one place that ever decides what
 * gets written to these columns.
 *
 * Grouped by order, not by scan — a single order (an EPG box's several
 * parcels, say) can back multiple `scan` rows, and this only needs to ask
 * Shopify once per distinct order regardless of how many parcels matched it.
 */
export async function backfillDestinationCountries(): Promise<BackfillCountriesResult> {
  const rows = await db
    .select({ orderGid: scan.orderGid, trackingNumber: scan.trackingNumber })
    .from(scan)
    .where(
      and(
        isNotNull(scan.orderGid),
        // Either field missing counts as a candidate — a scan already
        // backfilled for country before customerShippingAmount existed
        // would otherwise never be revisited by this button again, since
        // its destinationCountry is already set. Caught live: an admin ran
        // this once for country, then charged-shipping never appeared for
        // scans matched before that field was added.
        or(isNull(scan.destinationCountry), isNull(scan.customerShippingAmount)),
      ),
    );

  const trackingByOrder = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.orderGid) continue;
    const list = trackingByOrder.get(r.orderGid);
    if (list) list.push(r.trackingNumber);
    else trackingByOrder.set(r.orderGid, [r.trackingNumber]);
  }

  const candidates = trackingByOrder.size;
  const orderGids = [...trackingByOrder.keys()].slice(0, MAX_ORDERS_PER_BACKFILL_RUN);

  let updated = 0;
  let errors = 0;
  for (const orderGid of orderGids) {
    try {
      const order = await getOrderSummary(orderGid);
      // Order genuinely gone (deleted/cancelled since it was scanned) — no
      // country to fill in, and retrying won't change that, so it's simply
      // skipped rather than counted as an error.
      if (!order) continue;
      await upsertOrderIndex(trackingByOrder.get(orderGid)!, order);
      updated += 1;
    } catch {
      errors += 1;
    }
  }

  return { candidates, processed: orderGids.length, updated, errors };
}

/** Prevents a signed-in user from using the order panel as a general Shopify lookup. */
export async function orderIsReferencedLocally(orderGid: string): Promise<boolean> {
  const scanned = await db.select({ id: scan.id }).from(scan).where(eq(scan.orderGid, orderGid)).limit(1);
  if (scanned.length) return true;
  const indexed = await db
    .select({ trackingNumber: shopifyOrderIndex.trackingNumber })
    .from(shopifyOrderIndex)
    .where(eq(shopifyOrderIndex.orderGid, orderGid))
    .limit(1);
  return indexed.length > 0;
}
