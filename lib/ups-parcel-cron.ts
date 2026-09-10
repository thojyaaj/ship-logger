import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt } from "drizzle-orm";
import { lookupUpsStatus } from "./ups";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;

// The UPS Track API has no published rate limit (PRD §10), unlike DHL's
// 1-call/5s free tier — no sleep between lookups needed. Still capped per
// run so a large backlog drains across scheduled runs instead of risking
// one long-running invocation; see dhl-status-cron.ts for the same posture.
const MAX_LOOKUPS_PER_RUN = 40;

function isTerminal(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return /delivered/i.test(statusLabel);
}

export type UpsParcelCronResult = {
  candidates: number;
  checked: number;
  updated: number;
  stillPending: number;
};

/**
 * Refreshes per-parcel UPS status for individual scans, mirroring
 * lib/dhl-status-cron.ts's per-scan model. This is separate from
 * lib/ups-cron.ts, which only ever refreshed one master UPS tracking number
 * per shipment session — every individual UPS-carrier scan was never looked
 * up at all, so its status stayed null indefinitely (unlike DHL and EPG,
 * which both get per-scan refreshes). Skips scans already in a terminal
 * state, caps the lookback window, and never lets one lookup failure be
 * fatal to the rest of the batch.
 */
export async function runUpsParcelStatusCron(): Promise<UpsParcelCronResult> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const allRecent = await db
    .select()
    .from(scan)
    .where(and(eq(scan.carrier, "ups"), gt(scan.scannedAt, cutoff)));

  const pending = allRecent
    .filter((s) => !isTerminal(s.statusLabel))
    // Oldest-checked-first (nulls — never checked — sort first) so a backlog
    // beyond MAX_LOOKUPS_PER_RUN drains breadth-first across runs instead of
    // the same head-of-list scans winning every single time.
    .sort((a, b) => (a.statusCheckedAt ?? "").localeCompare(b.statusCheckedAt ?? ""));

  const batch = pending.slice(0, MAX_LOOKUPS_PER_RUN);

  if (batch.length === 0) {
    return { candidates: allRecent.length, checked: 0, updated: 0, stillPending: pending.length };
  }

  let updated = 0;
  const now = nowSqlTimestamp();
  for (const s of batch) {
    const status = await lookupUpsStatus(s.trackingNumber);

    if (!status || status.notFound) {
      await db.update(scan).set({ statusCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }

    await db
      .update(scan)
      .set({
        statusCode: status.statusCode,
        statusLabel: status.statusLabel,
        statusAt: status.statusAt,
        statusCheckedAt: now,
      })
      .where(eq(scan.id, s.id));
    updated += 1;
  }

  return {
    candidates: allRecent.length,
    checked: batch.length,
    updated,
    stillPending: pending.length - updated,
  };
}
