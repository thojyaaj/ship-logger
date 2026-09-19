import "server-only";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine, scan } from "../db/schema";
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
 */

export type LineShipping = {
  /** This parcel's share of what the customer paid for shipping. */
  customerPaid: number | null;
  /** customerPaid less the marketplace fee, minus what was billed. Null when there's no order data. */
  profit: number | null;
};

export type ShippingSummary = {
  customerPaid: number;
  fee: number;
  billed: number;
  profit: number;
  /** Parcels with a figure (including duplicates), vs. without order data. */
  parcelsCounted: number;
  parcelsMissing: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function lineShipping(l: {
  status: string;
  invoicedAmount: number;
  invoicedCurrency: string;
  orderShipping: number | null;
  orderShippingCurrency: string | null;
  orderParcels: number | null;
}): LineShipping {
  if (l.status === "duplicate") return { customerPaid: 0, profit: round2(-l.invoicedAmount) };
  if (l.orderShipping === null) return { customerPaid: null, profit: null };
  if ((l.orderShippingCurrency ?? l.invoicedCurrency).toUpperCase() !== l.invoicedCurrency.toUpperCase()) {
    return { customerPaid: null, profit: null };
  }
  const customerPaid = l.orderShipping / Math.max(1, l.orderParcels ?? 1);
  return {
    customerPaid: round2(customerPaid),
    profit: round2(customerPaid * (1 - MARKETPLACE_FEE_RATE) - l.invoicedAmount),
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

  return db
    .select({
      id: invoiceAuditLine.id,
      auditId: invoiceAuditLine.auditId,
      status: invoiceAuditLine.status,
      invoicedAmount: invoiceAuditLine.invoicedAmount,
      invoicedCurrency: invoiceAuditLine.invoicedCurrency,
      orderShipping: scan.customerShippingAmount,
      orderShippingCurrency: scan.customerShippingCurrency,
      orderParcels: orderParcels.n,
    })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .leftJoin(scan, eq(scan.id, invoiceAuditLine.scanId))
    .leftJoin(orderParcels, eq(orderParcels.orderGid, scan.orderGid))
    .where(where);
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
    const s = out.get(r.auditId) ?? { customerPaid: 0, fee: 0, billed: 0, profit: 0, parcelsCounted: 0, parcelsMissing: 0 };
    const l = lineShipping(r);
    if (l.profit === null) {
      s.parcelsMissing++;
    } else {
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

export function sumShippingSummaries(summaries: Iterable<ShippingSummary>): ShippingSummary {
  const t: ShippingSummary = { customerPaid: 0, fee: 0, billed: 0, profit: 0, parcelsCounted: 0, parcelsMissing: 0 };
  for (const s of summaries) {
    t.customerPaid += s.customerPaid;
    t.fee += s.fee;
    t.billed += s.billed;
    t.profit += s.profit;
    t.parcelsCounted += s.parcelsCounted;
    t.parcelsMissing += s.parcelsMissing;
  }
  return { ...t, customerPaid: round2(t.customerPaid), fee: round2(t.fee), billed: round2(t.billed), profit: round2(t.profit) };
}
