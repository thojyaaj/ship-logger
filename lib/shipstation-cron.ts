import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { lookupShipstationLabel } from "./shipstation";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;

// ShipStation v2 allows 200 requests/minute (docs.shipstation.com/rate-limits)
// — far more headroom than DHL Tracking's 1-call/5s, so a light pace is
// purely good-citizenship, not a hard constraint.
const RATE_LIMIT_MS = 350;

// Same reasoning as lib/dhl-status-cron.ts's MAX_LOOKUPS_PER_RUN: stay well
// inside Vercel's 60s function ceiling (100 * 350ms ≈ 35s, with margin for DB
// round-trips) and let a backlog drain oldest-first across runs rather than
// needing one long-running invocation.
const MAX_LOOKUPS_PER_RUN = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ShipstationLabelCronResult = {
  candidates: number;
  checked: number;
  updated: number;
  stillPending: number;
};

/**
 * Backfills real per-parcel weight/dimensions from ShipStation for scanned
 * DHL parcels (see lib/shipstation.ts) — only DHL for now, since the pickup
 * weight calculation in lib/dhl-pickup.ts is the only consumer. A scan
 * missing all four `shipstation*` columns is the "not yet backfilled"
 * signal; a lookup that fails or comes back empty just gets
 * `shipstationCheckedAt` stamped so it cycles to the back of the queue
 * instead of blocking the batch every run.
 */
export async function runShipstationLabelCron(): Promise<ShipstationLabelCronResult> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const allRecent = await db
    .select()
    .from(scan)
    .where(and(eq(scan.carrier, "dhl"), isNull(scan.shipstationWeightLb), gt(scan.scannedAt, cutoff)));

  // Oldest-checked-first (nulls — never checked — sort first) so a backlog
  // beyond MAX_LOOKUPS_PER_RUN drains breadth-first across runs instead of
  // the same head-of-list scans winning every single time.
  const pending = [...allRecent].sort((a, b) => (a.shipstationCheckedAt ?? "").localeCompare(b.shipstationCheckedAt ?? ""));
  const batch = pending.slice(0, MAX_LOOKUPS_PER_RUN);

  if (batch.length === 0) {
    return { candidates: allRecent.length, checked: 0, updated: 0, stillPending: pending.length };
  }

  let updated = 0;
  const now = nowSqlTimestamp();
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_MS);
    const s = batch[i];
    const label = await lookupShipstationLabel(s.trackingNumber);

    if (!label) {
      await db.update(scan).set({ shipstationCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }

    await db
      .update(scan)
      .set({
        shipstationWeightLb: label.weightLb,
        shipstationLengthIn: label.lengthIn,
        shipstationWidthIn: label.widthIn,
        shipstationHeightIn: label.heightIn,
        shipstationCheckedAt: now,
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
