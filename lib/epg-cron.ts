import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt } from "drizzle-orm";
import { lookupEpgStatuses } from "./epg";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;

function isTerminal(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return /delivered|returned to sender|return to shipper/i.test(statusLabel);
}

export type EpgCronResult = {
  candidates: number;
  updated: number;
  stillPending: number;
};

/**
 * Refreshes EPG status for scans that aren't already in a terminal state,
 * capped to a lookback window so cost (such as it is — this is free, but
 * still uncourteous to hammer an undocumented endpoint) stays bounded.
 * See PRD §8.9 / §5.6.
 */
export async function runEpgStatusCron(): Promise<EpgCronResult> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  // "Not terminal" is a regex-ish check on status text, awkward to express in
  // SQL — pull recent EPG scans and filter in JS instead. Row count here is
  // small enough (one warehouse's daily volume) that this is simpler, not slower.
  const allRecent = await db
    .select()
    .from(scan)
    .where(and(eq(scan.carrier, "epg"), gt(scan.scannedAt, cutoff)));
  const pending = allRecent.filter((s) => !isTerminal(s.statusLabel));

  if (pending.length === 0) {
    return { candidates: allRecent.length, updated: 0, stillPending: 0 };
  }

  const trackingNumbers = pending.map((s) => s.trackingNumber);
  const results = await lookupEpgStatuses(trackingNumbers);

  let updated = 0;
  const now = nowSqlTimestamp();
  for (const s of pending) {
    const record = results.get(s.trackingNumber);
    if (!record) {
      await db.update(scan).set({ statusCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }
    await db
      .update(scan)
      .set({
        epgExternalRef: record.externalRef,
        epgFinalMile: record.finalMileTracking,
        statusCode: record.latestEvent ? String(record.latestEvent.categoryId) : null,
        statusLabel: record.latestEvent?.event ?? null,
        statusAt: record.latestEvent?.eventAt ?? null,
        statusCheckedAt: now,
      })
      .where(eq(scan.id, s.id));
    updated += 1;
  }

  return {
    candidates: allRecent.length,
    updated,
    stillPending: pending.length - updated,
  };
}
