import "server-only";
import { and, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine, scan, shopifyOrderIndex } from "../db/schema";
import { MARKETPLACE_FEE_RATE } from "./format";

/**
 * Shipping profit/loss per billed parcel: what the customer paid for
 * shipping, less Fruugo's fee, less what the carrier actually billed.
 *
 * Computed on read from the matched scan rather than stored on the audit
 * line, so it picks up order matches that land after the audit ran (EPG
 * parcels get their order from the nightly EPG status cron) with no
 * re-audit.
 *
 * - An order shipped as several parcels had its shipping paid once, so it's
 *   split evenly across that order's scanned parcels instead of credited
 *   in full to each.
 * - A parcel billed twice earns nothing the second time: the duplicate
 *   line's whole billed amount is a loss.
 * - No matched order (or a currency that differs from the invoice's) means
 *   no figure — left out of totals and counted as missing, not read as $0.
 *
 * Where the customer's shipping charge comes from, in order:
 * 1. The scanned parcel's own order data (scan.customerShippingAmount).
 * 2. Failing that, the Shopify order index (fed by fulfillment webhooks),
 *    looked up by the invoice's EPG reference or final-mile tracking
 *    number — which finds the order for a parcel that was never scanned
 *    in ship_logger, or was scanned before its order matched.
 */

/** Why a parcel has no shipping figure — shown next to the blank so it isn't a mystery. */
export type MissingReason = "no_scan" | "no_order" | "currency";

export type LineShipping = {
  /** This parcel's share of what the customer paid for shipping. */
  customerPaid: number | null;
  /** customerPaid less the marketplace fee, minus what was billed. Null when there's no order data. */
  profit: number | null;
  /** Set exactly when customerPaid is null. */
  reason: MissingReason | null;
  /** Where the customer charge came from; null when there isn't one. */
  source: "scan" | "shopify" | "shipstation" | null;
  /** What a lookup said when it couldn't find the order (see lib/invoice-audit/enrich.ts). */
  detail: string | null;
};

export type ShippingSummary = {
  customerPaid: number;
  fee: number;
  billed: number;
  profit: number;
  /** Parcels with a figure (including duplicates), vs. without order data. */
  parcelsCounted: number;
  parcelsMissing: number;
  /** Why parcels are missing (sums to parcelsMissing). */
  missingNoScan: number;
  missingNoOrder: number;
  missingCurrency: number;
  /** Parcels matched to a scan in ship_logger, regardless of order data. */
  parcelsScanned: number;
  /** Parcels whose customer charge came from Shopify's fulfillment records, not a scan. */
  fromOrderIndex: number;
  /** Parcels whose ship date or customer charge came through ShipStation. */
  fromShipstation: number;
  parcelsTotal: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function lineShipping(l: {
  status: string;
  invoicedAmount: number;
  invoicedCurrency: string;
  hasScan: boolean;
  orderShipping: number | null;
  orderShippingCurrency: string | null;
  orderParcels: number | null;
  source?: LineShipping["source"];
  detail?: string | null;
}): LineShipping {
  const detail = l.detail ?? null;
  if (l.status === "duplicate") return { customerPaid: 0, profit: round2(-l.invoicedAmount), reason: null, source: null, detail };
  if (l.orderShipping === null) {
    return { customerPaid: null, profit: null, reason: l.hasScan ? "no_order" : "no_scan", source: null, detail };
  }
  if ((l.orderShippingCurrency ?? l.invoicedCurrency).toUpperCase() !== l.invoicedCurrency.toUpperCase()) {
    return { customerPaid: null, profit: null, reason: "currency", source: null, detail };
  }
  const customerPaid = l.orderShipping / Math.max(1, l.orderParcels ?? 1);
  return {
    customerPaid: round2(customerPaid),
    profit: round2(customerPaid * (1 - MARKETPLACE_FEE_RATE) - l.invoicedAmount),
    reason: null,
    source: l.source ?? "scan",
    detail,
  };
}

async function loadLines(where: SQL | undefined) {
  // Scanned parcels per order, to split a multi-parcel order's shipping.
  const orderParcels = db
    .select({ orderGid: scan.orderGid, n: sql<number>`count(*)::int`.as("n") })
    .from(scan)
    .where(isNotNull(scan.orderGid))
    .groupBy(scan.orderGid)
    .as("order_parcels");

  const rows = await db
    .select({
      id: invoiceAuditLine.id,
      auditId: invoiceAuditLine.auditId,
      status: invoiceAuditLine.status,
      invoicedAmount: invoiceAuditLine.invoicedAmount,
      invoicedCurrency: invoiceAuditLine.invoicedCurrency,
      epgRef: invoiceAuditLine.epgRef,
      finalMileTracking: invoiceAuditLine.finalMileTracking,
      scanId: invoiceAuditLine.scanId,
      scanRowId: scan.id,
      orderShipping: scan.customerShippingAmount,
      orderShippingCurrency: scan.customerShippingCurrency,
      orderParcels: orderParcels.n,
      // Looked up through ShipStation → Shopify (lib/invoice-audit/enrich.ts).
      enrichedAmount: invoiceAuditLine.orderShippingAmount,
      enrichedCurrency: invoiceAuditLine.orderShippingCurrency,
      orderRef: invoiceAuditLine.orderRef,
      enrichNote: invoiceAuditLine.enrichNote,
    })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .leftJoin(scan, eq(scan.id, invoiceAuditLine.scanId))
    .leftJoin(orderParcels, eq(orderParcels.orderGid, scan.orderGid))
    .where(where);

  // Parcels per ShipStation order, to split a multi-parcel order's shipping
  // the same way scans do: count every audit line pointing at that order.
  const enrichedRefs = [...new Set(rows.filter((r) => r.enrichedAmount !== null && r.orderRef).map((r) => r.orderRef!))];
  const perRef = new Map<string, number>();
  if (enrichedRefs.length > 0) {
    const counts = await db
      .select({ orderRef: invoiceAuditLine.orderRef, n: sql<number>`count(*)::int` })
      .from(invoiceAuditLine)
      .where(and(inArray(invoiceAuditLine.orderRef, enrichedRefs), ne(invoiceAuditLine.status, "duplicate")))
      .groupBy(invoiceAuditLine.orderRef);
    for (const c of counts) perRef.set(c.orderRef!, c.n);
  }

  // Fallback for parcels whose scan has no order data (or that were never
  // scanned): the Shopify order index, by either tracking number on the invoice.
  const needIndex = rows.filter((r) => r.orderShipping === null && r.enrichedAmount === null && r.status !== "duplicate");
  const refs = [...new Set(needIndex.flatMap((r) => [r.epgRef, r.finalMileTracking]).filter((v): v is string => !!v))];
  const indexed = new Map<string, { orderGid: string; amount: number | null; currency: string | null }>();
  const perOrder = new Map<string, number>();
  if (refs.length > 0) {
    const idx = await db
      .select({
        trackingNumber: shopifyOrderIndex.trackingNumber,
        orderGid: shopifyOrderIndex.orderGid,
        amount: shopifyOrderIndex.customerShippingAmount,
        currency: shopifyOrderIndex.customerShippingCurrency,
      })
      .from(shopifyOrderIndex)
      .where(inArray(shopifyOrderIndex.trackingNumber, refs));
    for (const r of idx) indexed.set(r.trackingNumber.toUpperCase(), r);
    const gids = [...new Set(idx.map((r) => r.orderGid))];
    if (gids.length > 0) {
      const counts = await db
        .select({ orderGid: shopifyOrderIndex.orderGid, n: sql<number>`count(*)::int` })
        .from(shopifyOrderIndex)
        .where(inArray(shopifyOrderIndex.orderGid, gids))
        .groupBy(shopifyOrderIndex.orderGid);
      for (const c of counts) perOrder.set(c.orderGid, c.n);
    }
  }

  return rows.map((r) => {
    const hasScan = r.scanRowId !== null;
    const detail = r.enrichNote;
    if (r.orderShipping !== null || r.status === "duplicate") {
      return { ...r, hasScan, fromIndex: false, source: "scan" as const, detail };
    }
    if (r.enrichedAmount !== null) {
      return {
        ...r,
        hasScan,
        fromIndex: false,
        source: "shipstation" as const,
        detail,
        orderShipping: r.enrichedAmount,
        orderShippingCurrency: r.enrichedCurrency,
        orderParcels: perRef.get(r.orderRef ?? "") ?? 1,
      };
    }
    const hit =
      (r.epgRef && indexed.get(r.epgRef.toUpperCase())) || (r.finalMileTracking && indexed.get(r.finalMileTracking.toUpperCase())) || null;
    if (!hit || hit.amount === null) return { ...r, hasScan, fromIndex: false, source: null, detail };
    return {
      ...r,
      hasScan,
      fromIndex: true,
      source: "shopify" as const,
      detail,
      orderShipping: hit.amount,
      orderShippingCurrency: hit.currency,
      orderParcels: perOrder.get(hit.orderGid) ?? 1,
    };
  });
}

/** Per-line figures for one audit, keyed by line id. */
export async function getLineShipping(auditId: string): Promise<Map<string, LineShipping>> {
  const rows = await loadLines(eq(invoiceAuditLine.auditId, auditId));
  return new Map(rows.map((r) => [r.id, lineShipping(r)]));
}

/** Per-audit totals for every EPG audit (or just `auditIds`), keyed by audit id. */
export async function getShippingSummaries(auditIds?: string[]): Promise<Map<string, ShippingSummary>> {
  if (auditIds && auditIds.length === 0) return new Map();
  const rows = await loadLines(
    and(eq(invoiceAudit.carrier, "epg"), auditIds ? inArray(invoiceAuditLine.auditId, auditIds) : undefined),
  );

  const out = new Map<string, ShippingSummary>();
  for (const r of rows) {
    const s = out.get(r.auditId) ?? emptySummary();
    const l = lineShipping(r);
    s.parcelsTotal++;
    if (r.hasScan) s.parcelsScanned++;
    if (l.profit === null) {
      s.parcelsMissing++;
      if (l.reason === "no_scan") s.missingNoScan++;
      else if (l.reason === "no_order") s.missingNoOrder++;
      else s.missingCurrency++;
    } else {
      if (r.fromIndex) s.fromOrderIndex++;
      if (r.source === "shipstation") s.fromShipstation++;
      s.parcelsCounted++;
      s.customerPaid += l.customerPaid ?? 0;
      s.fee += (l.customerPaid ?? 0) * MARKETPLACE_FEE_RATE;
      s.billed += r.invoicedAmount;
      s.profit += l.profit;
    }
    out.set(r.auditId, s);
  }
  for (const s of out.values()) {
    s.customerPaid = round2(s.customerPaid);
    s.fee = round2(s.fee);
    s.billed = round2(s.billed);
    s.profit = round2(s.profit);
  }
  return out;
}

function emptySummary(): ShippingSummary {
  return {
    customerPaid: 0, fee: 0, billed: 0, profit: 0, parcelsCounted: 0, parcelsMissing: 0,
    missingNoScan: 0, missingNoOrder: 0, missingCurrency: 0, parcelsScanned: 0, fromOrderIndex: 0, fromShipstation: 0, parcelsTotal: 0,
  };
}

export function sumShippingSummaries(summaries: Iterable<ShippingSummary>): ShippingSummary {
  const t = emptySummary();
  for (const s of summaries) {
    for (const k of Object.keys(t) as (keyof ShippingSummary)[]) t[k] += s[k];
  }
  return { ...t, customerPaid: round2(t.customerPaid), fee: round2(t.fee), billed: round2(t.billed), profit: round2(t.profit) };
}
