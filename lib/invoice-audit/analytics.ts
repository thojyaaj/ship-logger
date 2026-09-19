import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine } from "../db/schema";
import { netOvercharge } from "./format";

/**
 * Cross-invoice figures for the Invoices page — how much EPG has billed
 * over (or under) ShipStation's quotes across every audited invoice, and
 * where the overcharges come from. Always over *verified* parcels only:
 * an unverified parcel has no quote to compare against.
 */

// Last N invoices on the net-per-invoice chart — enough for a trend without
// bars getting too thin to hover on a phone.
const CHART_INVOICES = 24;
const TOP_COUNTRIES = 6;

export type OverchargeCause = "rate" | "heavier" | "surcharge" | "duplicate";

export type InvoiceAnalytics = {
  invoiceCount: number;
  currency: string;
  invoicedTotal: number;
  overchargeTotal: number;
  underchargeTotal: number;
  net: number;
  verifiedParcels: number;
  overchargedParcels: number;
  unverifiedParcels: number;
  /** Oldest → newest, the latest CHART_INVOICES only. */
  perInvoice: { id: string; invoiceNumber: string; net: number; overchargeTotal: number; underchargeTotal: number }[];
  byCause: { cause: OverchargeCause; count: number; amount: number }[];
  byCountry: { country: string; count: number; amount: number }[];
};

/**
 * One cause per overcharged parcel, most specific first, so the amounts add
 * up to the overcharge total instead of double-counting a parcel that was
 * both billed heavier and surcharged.
 */
function causeOf(l: { status: string; billedHeavier: boolean; surchargeTotal: number }): OverchargeCause {
  if (l.status === "duplicate") return "duplicate";
  if (l.billedHeavier) return "heavier";
  if (l.surchargeTotal > 0) return "surcharge";
  return "rate";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getInvoiceAnalytics(): Promise<InvoiceAnalytics> {
  const audits = await db
    .select()
    .from(invoiceAudit)
    .where(eq(invoiceAudit.carrier, "epg"))
    // Invoice number, not audit date: EPG numbers them sequentially
    // (OTCBIX204, 205…), and an old invoice backfilled today would
    // otherwise plot as the newest.
    .orderBy(asc(invoiceAudit.invoiceNumber));

  const overLines = await db
    .select({
      status: invoiceAuditLine.status,
      billedHeavier: invoiceAuditLine.billedHeavier,
      surchargeTotal: invoiceAuditLine.surchargeTotal,
      difference: invoiceAuditLine.difference,
      country: invoiceAuditLine.destinationCountry,
    })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .where(and(eq(invoiceAudit.carrier, "epg"), inArray(invoiceAuditLine.status, ["over", "duplicate"])));

  const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));
  const overchargeTotal = sum(audits.map((a) => a.overchargeTotal));
  const underchargeTotal = sum(audits.map((a) => a.underchargeTotal));

  const causes = new Map<OverchargeCause, { count: number; amount: number }>();
  const countries = new Map<string, { count: number; amount: number }>();
  for (const l of overLines) {
    const amount = l.difference ?? 0;
    const c = causes.get(causeOf(l)) ?? { count: 0, amount: 0 };
    causes.set(causeOf(l), { count: c.count + 1, amount: c.amount + amount });
    const key = l.country ?? "Unknown";
    const k = countries.get(key) ?? { count: 0, amount: 0 };
    countries.set(key, { count: k.count + 1, amount: k.amount + amount });
  }

  return {
    invoiceCount: audits.length,
    currency: audits[0]?.currency ?? "USD",
    invoicedTotal: sum(audits.map((a) => a.invoicedTotal)),
    overchargeTotal,
    underchargeTotal,
    net: netOvercharge({ overchargeTotal, underchargeTotal }),
    verifiedParcels: audits.reduce((n, a) => n + a.overCount + a.underCount + a.matchCount + a.duplicateCount, 0),
    overchargedParcels: audits.reduce((n, a) => n + a.overCount + a.duplicateCount, 0),
    unverifiedParcels: audits.reduce((n, a) => n + a.noQuoteCount + a.notFoundCount, 0),
    perInvoice: audits.slice(-CHART_INVOICES).map((a) => ({
      id: a.id,
      invoiceNumber: a.invoiceNumber,
      net: netOvercharge(a),
      overchargeTotal: a.overchargeTotal,
      underchargeTotal: a.underchargeTotal,
    })),
    byCause: (["rate", "heavier", "surcharge", "duplicate"] as OverchargeCause[])
      .map((cause) => ({ cause, count: causes.get(cause)?.count ?? 0, amount: round2(causes.get(cause)?.amount ?? 0) }))
      .filter((c) => c.count > 0),
    byCountry: [...countries.entries()]
      .map(([country, v]) => ({ country, count: v.count, amount: round2(v.amount) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, TOP_COUNTRIES),
  };
}
