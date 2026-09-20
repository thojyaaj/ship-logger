import "server-only";
import { and, desc, eq, isNotNull, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine, scan } from "../db/schema";
import { nowSqlTimestamp, toSqlTimestamp } from "../date";
import { lookupShipstationParcel } from "../shipstation";
import { findOrderByName, getOrderSummary } from "../shopify";

/**
 * Fills in ship date and what the customer paid for shipping for invoice
 * parcels ship_logger has no scan (or no scan order) for, using ShipStation
 * and Shopify:
 *
 *   parcel's EPG reference → ShipStation label (ship date, shipment id)
 *     → ShipStation shipment (external_order_id)
 *       → Shopify order (shipping charge)
 *
 * ShipStation's v2 API doesn't carry what the customer paid — only the order
 * source's own order id — so the charge comes from Shopify, the same source
 * of truth a scan's order would give. What each step found (or why it
 * didn't) is stored on the audit line, so nothing is looked up twice and a
 * blank on the page can say what went wrong.
 */

// Per run: each parcel costs two ShipStation calls (limit 200/min) plus at
// most one Shopify call; this keeps a run near 40s inside Vercel's 60s cap.
export const MAX_PARCELS_PER_RUN = 40;
const PACE_MS = 300;

// A parcel that came back with a note (label not found, order not found in
// Shopify) is retried after this long — a label or order can show up late.
const RETRY_AFTER_DAYS = 7;

// Consecutive ShipStation/Shopify API failures before a run gives up rather
// than burning the rest of its budget on an outage.
const MAX_CONSECUTIVE_ERRORS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EnrichBudget = { remaining: number };

export type EnrichResult = {
  checked: number;
  shipDates: number;
  customerCharges: number;
  /** Still needing a lookup after this pass. */
  remaining: number;
  /** Stopped early on repeated API failures. */
  aborted: boolean;
};

/** Parcels worth a lookup: not billed twice, missing a scan or its order, and never looked up (or due a retry). */
function candidateWhere(scope: { auditId?: string }, now: Date): SQL | undefined {
  const retryBefore = toSqlTimestamp(new Date(now.getTime() - RETRY_AFTER_DAYS * 24 * 60 * 60 * 1000));
  return and(
    eq(invoiceAudit.carrier, "epg"),
    scope.auditId ? eq(invoiceAuditLine.auditId, scope.auditId) : undefined,
    ne(invoiceAuditLine.status, "duplicate"),
    or(isNull(invoiceAuditLine.scanId), isNull(scan.customerShippingAmount)),
    // Something to look up under.
    or(isNotNull(invoiceAuditLine.epgRef), isNotNull(invoiceAuditLine.finalMileTracking)),
    or(
      isNull(invoiceAuditLine.enrichedAt),
      and(isNotNull(invoiceAuditLine.enrichNote), lt(invoiceAuditLine.enrichedAt, retryBefore)),
    ),
  );
}

export async function countEnrichmentCandidates(auditId: string, now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ id: invoiceAuditLine.id })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAudit.id, invoiceAuditLine.auditId))
    .leftJoin(scan, eq(scan.id, invoiceAuditLine.scanId))
    .where(candidateWhere({ auditId }, now));
  return rows.length;
}

type ShopifyOrderHit =
  | { found: true; name: string; amount: number | null; currency: string | null }
  | { found: false }
  | { error: true };

/**
 * ShipStation's external_order_id is whatever the order source called the
 * order: a long numeric Shopify id, or an order number/name. Try the shape
 * it looks like first, then the other.
 */
async function resolveShopifyOrder(ref: string, cache: Map<string, ShopifyOrderHit>): Promise<ShopifyOrderHit> {
  const cached = cache.get(ref);
  if (cached) return cached;

  let hit: ShopifyOrderHit;
  try {
    const byId = /^\d{10,}$/.test(ref) ? await getOrderSummary(ref) : null;
    if (byId) {
      hit = { found: true, name: byId.name, amount: byId.customerShippingAmount, currency: byId.customerShippingCurrency };
    } else {
      const named = await findOrderByName(ref);
      hit = named
        ? { found: true, name: named.name, amount: named.customerShippingAmount, currency: named.customerShippingCurrency }
        : { found: false };
    }
  } catch (err) {
    console.error(`[invoice-enrich] Shopify lookup for order ref ${ref} failed:`, err);
    return { error: true }; // not cached: a later parcel of the same order can retry
  }
  cache.set(ref, hit);
  return hit;
}

/**
 * Looks up ship date and customer charge for up to `budget.remaining`
 * candidate parcels, newest invoice first (or just one audit's). Safe to run
 * repeatedly: a parcel is only ever looked up again if it never was, or a
 * week has passed since a lookup that came back with a note.
 */
export async function enrichInvoiceLines(
  scope: { auditId?: string },
  budget: EnrichBudget = { remaining: MAX_PARCELS_PER_RUN },
  now: Date = new Date(),
): Promise<EnrichResult> {
  const candidates = await db
    .select({
      id: invoiceAuditLine.id,
      epgRef: invoiceAuditLine.epgRef,
      finalMileTracking: invoiceAuditLine.finalMileTracking,
      hasScan: isNotNull(invoiceAuditLine.scanId),
    })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAudit.id, invoiceAuditLine.auditId))
    .leftJoin(scan, eq(scan.id, invoiceAuditLine.scanId))
    .where(candidateWhere(scope, now))
    .orderBy(desc(invoiceAudit.invoiceNumber), invoiceAuditLine.sheetRow);

  const orders = new Map<string, ShopifyOrderHit>();
  const result: EnrichResult = { checked: 0, shipDates: 0, customerCharges: 0, remaining: 0, aborted: false };
  let consecutiveErrors = 0;
  let looked = 0;

  for (const line of candidates) {
    if (budget.remaining <= 0 || result.aborted) break;
    const tracking = line.epgRef ?? line.finalMileTracking!;

    if (looked > 0) await sleep(PACE_MS);
    looked++;
    budget.remaining--;
    result.checked++;

    const parcel = await lookupShipstationParcel(tracking);
    if (parcel.status === "error") {
      // Left untouched, so it stays a candidate for the next run.
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) result.aborted = true;
      continue;
    }
    consecutiveErrors = 0;

    const stamp = nowSqlTimestamp();
    if (parcel.status === "not_found") {
      await db
        .update(invoiceAuditLine)
        .set({ enrichedAt: stamp, enrichNote: "No ShipStation label found for this parcel." })
        .where(eq(invoiceAuditLine.id, line.id));
      continue;
    }

    const { shipDate, externalOrderId } = parcel.shipment;
    const update: Partial<typeof invoiceAuditLine.$inferInsert> = { enrichedAt: stamp, enrichNote: null };
    if (shipDate) {
      update.shipstationShipDate = shipDate;
      if (!line.hasScan) result.shipDates++;
    }

    if (!externalOrderId) {
      update.enrichNote = "ShipStation has this label but no order id on it.";
    } else {
      update.orderRef = externalOrderId;
      const order = await resolveShopifyOrder(externalOrderId, orders);
      if ("error" in order) {
        // Transient: keep the ship date, but leave the parcel unenriched so the next run retries the order.
        update.enrichedAt = null;
        if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) result.aborted = true;
      } else if (!order.found) {
        update.enrichNote = `ShipStation's order id ${externalOrderId} wasn't found in Shopify.`;
      } else if (order.amount === null) {
        update.orderName = order.name;
        update.enrichNote = `Shopify order ${order.name} has no shipping charge on it.`;
      } else {
        update.orderName = order.name;
        update.orderShippingAmount = order.amount;
        update.orderShippingCurrency = order.currency;
        result.customerCharges++;
      }
    }

    await db.update(invoiceAuditLine).set(update).where(eq(invoiceAuditLine.id, line.id));
  }

  result.remaining = await countRemaining(scope, now);
  return result;
}

async function countRemaining(scope: { auditId?: string }, now: Date): Promise<number> {
  const rows = await db
    .select({ id: invoiceAuditLine.id })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAudit.id, invoiceAuditLine.auditId))
    .leftJoin(scan, eq(scan.id, invoiceAuditLine.scanId))
    .where(candidateWhere(scope, now));
  return rows.length;
}
