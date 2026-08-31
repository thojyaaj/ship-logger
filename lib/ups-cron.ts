import "server-only";
import { db } from "./db";
import { shipmentSession } from "./db/schema";
import { and, eq, gte, isNotNull, ne } from "drizzle-orm";
import { lookupUpsStatuses } from "./ups";
import { nowSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;

function isTerminal(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return /delivered/i.test(statusLabel);
}

function cutoffDate(): string {
  return new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type UpsCronResult = {
  candidates: number;
  updated: number;
  stillPending: number;
};

/**
 * Refreshes master UPS tracking status for every non-voided session that
 * has one, mirroring lib/epg-cron.ts: skip sessions already in a terminal
 * state, cap the lookback window, never let a lookup failure be fatal.
 */
export async function runUpsStatusCron(): Promise<UpsCronResult> {
  const allRecent = await db
    .select()
    .from(shipmentSession)
    .where(
      and(
        isNotNull(shipmentSession.masterUpsTracking),
        ne(shipmentSession.status, "voided"),
        gte(shipmentSession.shipDate, cutoffDate()),
      ),
    );
  const pending = allRecent.filter((s) => !isTerminal(s.masterUpsStatusLabel));

  if (pending.length === 0) {
    return { candidates: allRecent.length, updated: 0, stillPending: 0 };
  }

  const trackingNumbers = pending
    .map((s) => s.masterUpsTracking)
    .filter((t): t is string => Boolean(t));
  const results = await lookupUpsStatuses(trackingNumbers);

  let updated = 0;
  const now = nowSqlTimestamp();
  for (const s of pending) {
    const status = s.masterUpsTracking ? results.get(s.masterUpsTracking) : null;
    if (!status || status.notFound) {
      await db
        .update(shipmentSession)
        .set({ masterUpsStatusCheckedAt: now })
        .where(eq(shipmentSession.id, s.id));
      continue;
    }

    await db
      .update(shipmentSession)
      .set({
        masterUpsStatusCode: status.statusCode,
        masterUpsStatusLabel: status.statusLabel,
        masterUpsStatusAt: status.statusAt,
        masterUpsStatusCheckedAt: now,
      })
      .where(eq(shipmentSession.id, s.id));
    updated += 1;
  }

  return { candidates: allRecent.length, updated, stillPending: pending.length - updated };
}
