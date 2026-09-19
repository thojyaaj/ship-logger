import "server-only";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine } from "../db/schema";
import { toSqlTimestamp } from "../date";
import { MAX_LIVE_LOOKUPS, UNVERIFIED, recheckUnverifiedLines, type LookupBudget } from "./audit";

// A parcel still without a quote a month after its invoice was audited is
// almost certainly never getting one (voided label, a parcel shipped
// outside ShipStation) — stop spending nightly lookups on it. The
// Re-check button on the audit still works for it by hand.
const RETRY_WINDOW_DAYS = 30;

export type InvoiceRecheckCronResult = {
  auditsChecked: number;
  lookupsUsed: number;
  resolved: number;
  stillUnverified: number;
};

/**
 * Nightly counterpart of the audit page's "Re-check unverified parcels"
 * button: re-checks every recent audit that still has no-quote / not-found
 * parcels, newest audit first. Scheduled after the shipstation-labels cron
 * (vercel.json) so the free re-match against newly saved scan costs sees
 * that night's backfill. Live ShipStation lookups share one budget of
 * MAX_LIVE_LOOKUPS across all audits, keeping the run inside Vercel's 60s
 * limit — anything left over is picked up the next night.
 */
export async function runInvoiceRecheckCron(now: Date = new Date()): Promise<InvoiceRecheckCronResult> {
  const since = toSqlTimestamp(new Date(now.getTime() - RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000));

  const audits = await db
    .selectDistinct({ id: invoiceAudit.id, createdAt: invoiceAudit.createdAt })
    .from(invoiceAudit)
    .innerJoin(invoiceAuditLine, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .where(and(gte(invoiceAudit.createdAt, since), inArray(invoiceAuditLine.status, UNVERIFIED)))
    .orderBy(desc(invoiceAudit.createdAt));

  const budget: LookupBudget = { remaining: MAX_LIVE_LOOKUPS, used: 0 };
  const result: InvoiceRecheckCronResult = { auditsChecked: 0, lookupsUsed: 0, resolved: 0, stillUnverified: 0 };

  for (const audit of audits) {
    // Keep going even with no live lookups left: the free re-match against
    // saved scan costs still resolves parcels at no API cost.
    const r = await recheckUnverifiedLines(audit.id, budget);
    result.auditsChecked++;
    result.resolved += r.resolved;
    result.stillUnverified += r.remaining;
  }
  result.lookupsUsed = budget.used;
  return result;
}
