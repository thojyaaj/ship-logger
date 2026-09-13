import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { lookupShipstationShipment } from "./shipstation";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;

// Same reasoning as lib/shipstation-cron.ts — 200 req/min is generous, this
// pace is good-citizenship, not a hard constraint.
const RATE_LIMIT_MS = 350;
const MAX_LOOKUPS_PER_RUN = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ShipstationOrderFallbackCronResult = {
  candidates: number;
  checked: number;
  updated: number;
  stillPending: number;
};

/**
 * Fills in an order-match fallback from ShipStation for scans Shopify's own
 * order-matching (lib/order-index.ts, lib/epg-cron.ts's ERef resolution)
 * never resolved — deliberately a fallback, not a replacement: this only
 * ever looks at scans where `orderGid IS NULL`, and if Shopify resolves one
 * later, that write (in upsertOrderIndex/epg-cron.ts) doesn't touch or clear
 * these columns, it just makes the real match take display precedence (see
 * ScanTable.tsx). Same resumable, oldest-checked-first shape as every other
 * ShipStation cron here.
 */
export async function runShipstationOrderFallbackCron(): Promise<ShipstationOrderFallbackCronResult> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const allRecent = await db
    .select()
    .from(scan)
    .where(and(isNull(scan.orderGid), isNull(scan.shipstationOrderFallback), gt(scan.scannedAt, cutoff)));

  const pending = [...allRecent].sort((a, b) =>
    (a.shipstationOrderFallbackCheckedAt ?? "").localeCompare(b.shipstationOrderFallbackCheckedAt ?? ""),
  );
  const batch = pending.slice(0, MAX_LOOKUPS_PER_RUN);

  if (batch.length === 0) {
    return { candidates: allRecent.length, checked: 0, updated: 0, stillPending: pending.length };
  }

  let updated = 0;
  const now = nowSqlTimestamp();
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_MS);
    const s = batch[i];
    const shipment = await lookupShipstationShipment(s.trackingNumber);

    if (!shipment || (!shipment.externalOrderId && !shipment.shipToName)) {
      await db.update(scan).set({ shipstationOrderFallbackCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }

    await db
      .update(scan)
      .set({
        shipstationOrderFallback: shipment.externalOrderId,
        shipstationShipToName: shipment.shipToName,
        shipstationOrderFallbackCheckedAt: now,
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
