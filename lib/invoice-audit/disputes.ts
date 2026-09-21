import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine, invoiceDispute } from "../db/schema";
import { newId } from "../id";
import { nowSqlTimestamp } from "../date";
import { ExpectedError } from "../expected-error";

/**
 * Tracks billing disputes sent to a carrier: which parcels were disputed,
 * when the dispute went out, and what came back (credited in full or in
 * part, or rejected). A parcel is in at most one dispute, so a new one only
 * ever picks up parcels not yet disputed — the same overcharge is never
 * sent twice.
 *
 * Lifecycle: draft (created, not sent — can be deleted, freeing its
 * parcels) → sent (Mark as sent) → resolved (every parcel has an outcome).
 *
 * A parcel can also be skipped — a decision not to dispute it — which keeps
 * it out of new disputes and out of the "still to dispute" counts, and is
 * reversible.
 */

export const DISPUTABLE_STATUSES = ["over", "duplicate"] as const;

export type DisputeOutcome = "pending" | "credited" | "rejected";
export type DisputeStatus = "draft" | "sent" | "resolved";

export type DisputeSummary = {
  id: string;
  createdAt: string;
  sentAt: string | null;
  status: DisputeStatus;
  invoiceNumbers: string[];
  parcels: number;
  disputed: number;
  credited: number;
  rejectedParcels: number;
  pendingParcels: number;
  currency: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Creates a draft dispute from every not-yet-disputed overcharged or
 * double-billed parcel on the given audits.
 */
export async function createDispute(auditIds: string[], userId: string): Promise<{ id: string; parcels: number }> {
  if (auditIds.length === 0) throw new ExpectedError("Choose at least one invoice.");
  const id = newId();

  const claimed = await db.transaction(async (tx) => {
    await tx.insert(invoiceDispute).values({ id, carrier: "epg", createdBy: userId });
    // Claimed in one UPDATE … WHERE dispute_id IS NULL, so two disputes
    // created at the same moment can't both take the same parcel.
    return tx
      .update(invoiceAuditLine)
      .set({
        disputeId: id,
        disputedAmount: invoiceAuditLine.difference,
        disputeOutcome: "pending",
        creditedAmount: null,
        disputeResolvedAt: null,
      })
      .where(
        and(
          inArray(invoiceAuditLine.auditId, auditIds),
          inArray(invoiceAuditLine.status, [...DISPUTABLE_STATUSES]),
          isNull(invoiceAuditLine.disputeId),
          isNull(invoiceAuditLine.disputeSkippedAt),
        ),
      )
      .returning({ id: invoiceAuditLine.id });
  });

  if (claimed.length === 0) {
    await db.delete(invoiceDispute).where(eq(invoiceDispute.id, id));
    throw new ExpectedError("Nothing new to dispute — every overcharged parcel on these invoices is already in a dispute or skipped.");
  }
  return { id, parcels: claimed.length };
}

export async function markDisputeSent(id: string, userId: string): Promise<void> {
  const [row] = await db
    .update(invoiceDispute)
    .set({ sentAt: nowSqlTimestamp(), sentBy: userId })
    .where(and(eq(invoiceDispute.id, id), isNull(invoiceDispute.sentAt)))
    .returning({ id: invoiceDispute.id });
  if (!row) throw new ExpectedError("That dispute was already marked as sent.");
}

/** Deletes a draft dispute and frees its parcels. A sent dispute is a record of what EPG received — kept. */
export async function deleteDraftDispute(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [d] = await tx.select({ sentAt: invoiceDispute.sentAt }).from(invoiceDispute).where(eq(invoiceDispute.id, id));
    if (!d) throw new ExpectedError("That dispute no longer exists.");
    if (d.sentAt) throw new ExpectedError("A dispute that's been sent can't be deleted.");
    await tx
      .update(invoiceAuditLine)
      .set({ disputeId: null, disputedAmount: null, disputeOutcome: null, creditedAmount: null, disputeResolvedAt: null })
      .where(eq(invoiceAuditLine.disputeId, id));
    await tx.delete(invoiceDispute).where(eq(invoiceDispute.id, id));
  });
}

/**
 * Records EPG's answer for some of a dispute's parcels. "credited" with no
 * amount credits each parcel's full disputed amount; with an amount (one
 * parcel only) it records a partial credit. "pending" undoes an outcome.
 */
export async function recordOutcome(
  disputeId: string,
  lineIds: string[],
  outcome: DisputeOutcome,
  creditedAmount?: number,
): Promise<void> {
  if (lineIds.length === 0) throw new ExpectedError("Select at least one parcel.");
  const [d] = await db.select({ sentAt: invoiceDispute.sentAt }).from(invoiceDispute).where(eq(invoiceDispute.id, disputeId));
  if (!d) throw new ExpectedError("That dispute no longer exists.");
  if (!d.sentAt) throw new ExpectedError("Mark the dispute as sent before recording EPG's answer.");

  let credit: SQLValue;
  if (outcome === "credited") {
    if (creditedAmount !== undefined) {
      if (lineIds.length !== 1) throw new ExpectedError("A custom credit amount applies to one parcel at a time.");
      if (!Number.isFinite(creditedAmount) || creditedAmount < 0) throw new ExpectedError("Enter a credit of $0 or more.");
      credit = round2(creditedAmount);
    } else {
      credit = sql`${invoiceAuditLine.disputedAmount}`;
    }
  } else {
    credit = null;
  }

  await db
    .update(invoiceAuditLine)
    .set({
      disputeOutcome: outcome,
      creditedAmount: credit,
      disputeResolvedAt: outcome === "pending" ? null : nowSqlTimestamp(),
    })
    .where(and(eq(invoiceAuditLine.disputeId, disputeId), inArray(invoiceAuditLine.id, lineIds)));
}

type SQLValue = number | null | ReturnType<typeof sql>;

async function summarize(where?: ReturnType<typeof eq>): Promise<DisputeSummary[]> {
  const disputes = await db.select().from(invoiceDispute).where(where).orderBy(desc(invoiceDispute.createdAt));
  if (disputes.length === 0) return [];
  const lines = await db
    .select({
      disputeId: invoiceAuditLine.disputeId,
      invoiceNumber: invoiceAudit.invoiceNumber,
      currency: invoiceAuditLine.invoicedCurrency,
      disputedAmount: invoiceAuditLine.disputedAmount,
      creditedAmount: invoiceAuditLine.creditedAmount,
      outcome: invoiceAuditLine.disputeOutcome,
    })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .where(inArray(invoiceAuditLine.disputeId, disputes.map((d) => d.id)));

  return disputes.map((d) => {
    const own = lines.filter((l) => l.disputeId === d.id);
    const pending = own.filter((l) => l.outcome === "pending").length;
    return {
      id: d.id,
      createdAt: d.createdAt,
      sentAt: d.sentAt,
      status: !d.sentAt ? "draft" : pending > 0 ? "sent" : "resolved",
      invoiceNumbers: [...new Set(own.map((l) => l.invoiceNumber))].sort(),
      parcels: own.length,
      disputed: round2(own.reduce((s, l) => s + (l.disputedAmount ?? 0), 0)),
      credited: round2(own.reduce((s, l) => s + (l.creditedAmount ?? 0), 0)),
      rejectedParcels: own.filter((l) => l.outcome === "rejected").length,
      pendingParcels: pending,
      currency: own[0]?.currency ?? "USD",
    };
  });
}

export function listDisputes(): Promise<DisputeSummary[]> {
  return summarize();
}

export async function getDisputeSummary(id: string): Promise<DisputeSummary | null> {
  return (await summarize(eq(invoiceDispute.id, id)))[0] ?? null;
}

/** Totals across every dispute, for the Invoices page. */
export function disputeTotals(disputes: DisputeSummary[]) {
  const sent = disputes.filter((d) => d.status !== "draft");
  return {
    disputed: round2(sent.reduce((s, d) => s + d.disputed, 0)),
    credited: round2(sent.reduce((s, d) => s + d.credited, 0)),
    pendingParcels: sent.reduce((n, d) => n + d.pendingParcels, 0),
    rejectedParcels: sent.reduce((n, d) => n + d.rejectedParcels, 0),
    sentCount: sent.length,
    draftCount: disputes.length - sent.length,
    currency: disputes[0]?.currency ?? "USD",
  };
}

/** Per audit: how many overcharged parcels aren't in any dispute yet. */
export async function undisputedCounts(auditIds: string[]): Promise<Map<string, { parcels: number; amount: number }>> {
  if (auditIds.length === 0) return new Map();
  const rows = await db
    .select({
      auditId: invoiceAuditLine.auditId,
      parcels: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${invoiceAuditLine.difference}), 0)`,
    })
    .from(invoiceAuditLine)
    .where(
      and(
        inArray(invoiceAuditLine.auditId, auditIds),
        inArray(invoiceAuditLine.status, [...DISPUTABLE_STATUSES]),
        isNull(invoiceAuditLine.disputeId),
        isNull(invoiceAuditLine.disputeSkippedAt),
      ),
    )
    .groupBy(invoiceAuditLine.auditId);
  return new Map(rows.map((r) => [r.auditId, { parcels: r.parcels, amount: round2(Number(r.amount)) }]));
}

/**
 * Skipping: deciding not to dispute a parcel. Only a disputable parcel that
 * isn't already in a dispute can be skipped (one in a draft is removed from
 * it with removeFromDraft; one in a sent dispute was already sent). All of
 * this is reversible.
 */
const skippable = (extra: SQL | undefined) =>
  and(
    inArray(invoiceAuditLine.status, [...DISPUTABLE_STATUSES]),
    isNull(invoiceAuditLine.disputeId),
    extra,
  );

/** Skips (or, with `skip: false`, restores) specific parcels. Returns how many changed. */
export async function setParcelsSkipped(lineIds: string[], skip: boolean): Promise<number> {
  if (lineIds.length === 0) throw new ExpectedError("Select at least one parcel.");
  const rows = await db
    .update(invoiceAuditLine)
    .set({ disputeSkippedAt: skip ? nowSqlTimestamp() : null })
    .where(
      skippable(
        and(
          inArray(invoiceAuditLine.id, lineIds),
          skip ? isNull(invoiceAuditLine.disputeSkippedAt) : isNotNull(invoiceAuditLine.disputeSkippedAt),
        ),
      ),
    )
    .returning({ id: invoiceAuditLine.id });
  return rows.length;
}

/** Skips (or restores) every parcel on one invoice that could be disputed and isn't in a dispute. */
export async function setAuditSkipped(auditId: string, skip: boolean): Promise<number> {
  const rows = await db
    .update(invoiceAuditLine)
    .set({ disputeSkippedAt: skip ? nowSqlTimestamp() : null })
    .where(
      skippable(
        and(
          eq(invoiceAuditLine.auditId, auditId),
          skip ? isNull(invoiceAuditLine.disputeSkippedAt) : isNotNull(invoiceAuditLine.disputeSkippedAt),
        ),
      ),
    )
    .returning({ id: invoiceAuditLine.id });
  return rows.length;
}

/**
 * Takes parcels out of a draft dispute and skips them, so they aren't
 * disputed and don't come straight back into the next one. A draft left
 * with no parcels is deleted. A dispute that's been sent can't change.
 */
export async function removeFromDraft(disputeId: string, lineIds: string[]): Promise<{ deletedDispute: boolean; removed: number }> {
  if (lineIds.length === 0) throw new ExpectedError("Select at least one parcel.");
  return db.transaction(async (tx) => {
    const [d] = await tx.select({ sentAt: invoiceDispute.sentAt }).from(invoiceDispute).where(eq(invoiceDispute.id, disputeId));
    if (!d) throw new ExpectedError("That dispute no longer exists.");
    if (d.sentAt) throw new ExpectedError("This dispute has been sent, so its parcels can't be removed.");

    const removed = await tx
      .update(invoiceAuditLine)
      .set({
        disputeId: null,
        disputedAmount: null,
        disputeOutcome: null,
        creditedAmount: null,
        disputeResolvedAt: null,
        disputeSkippedAt: nowSqlTimestamp(),
      })
      .where(and(eq(invoiceAuditLine.disputeId, disputeId), inArray(invoiceAuditLine.id, lineIds)))
      .returning({ id: invoiceAuditLine.id });

    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invoiceAuditLine)
      .where(eq(invoiceAuditLine.disputeId, disputeId));
    const deletedDispute = (left?.n ?? 0) === 0;
    if (deletedDispute) await tx.delete(invoiceDispute).where(eq(invoiceDispute.id, disputeId));
    return { deletedDispute, removed: removed.length };
  });
}

/** Parcels skipped across every invoice, for the Invoices page. */
export async function skippedTotals(): Promise<{ parcels: number; amount: number }> {
  const [row] = await db
    .select({
      parcels: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${invoiceAuditLine.difference}), 0)`,
    })
    .from(invoiceAuditLine)
    .where(and(isNotNull(invoiceAuditLine.disputeSkippedAt), isNull(invoiceAuditLine.disputeId)));
  return { parcels: row?.parcels ?? 0, amount: round2(Number(row?.amount ?? 0)) };
}
