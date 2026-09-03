import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt } from "drizzle-orm";
import { lookupDhlStatus } from "./dhl-track";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;

// DHL Unified's free tier is 1 call per 5 seconds, 250/day (PRD §5.2/§10).
const RATE_LIMIT_MS = 5_000;

// Vercel's default serverless Function duration is 10s, and even with
// `export const maxDuration = 60` on the route (see
// app/api/cron/dhl-status/route.ts), a Hobby-plan project can't go past 60s
// at all. At one lookup per RATE_LIMIT_MS that leaves room for about 10
// calls with margin for the DB round-trips around them. Anything past that
// carries over to the next scheduled run rather than needing one long-running
// invocation — see the oldest-checked-first ordering below and PRD §10:
// "make the job resumable and don't let it stampede."
const MAX_LOOKUPS_PER_RUN = 10;

function isTerminal(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return /delivered/i.test(statusLabel);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DhlCronResult = {
  candidates: number;
  checked: number;
  updated: number;
  stillPending: number;
};

/**
 * Refreshes per-parcel DHL status for unboxed scans, mirroring
 * lib/epg-cron.ts's per-scan model (DHL parcels, like EPG's, are scanned and
 * tracked individually — unlike UPS's session-level master tracking). Skips
 * scans already in a terminal state, caps the lookback window, and never
 * lets one lookup failure be fatal to the rest of the batch.
 */
export async function runDhlStatusCron(): Promise<DhlCronResult> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const allRecent = await db
    .select()
    .from(scan)
    .where(and(eq(scan.carrier, "dhl"), gt(scan.scannedAt, cutoff)));

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
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_MS);
    const s = batch[i];
    const status = await lookupDhlStatus(s.trackingNumber);

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
