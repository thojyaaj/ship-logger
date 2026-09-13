import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { lookupShipstationTracking } from "./shipstation";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;
const RATE_LIMIT_MS = 350;
const MAX_LOOKUPS_PER_RUN = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ShipstationDeliveryCronResult = {
  candidates: number;
  checked: number;
  updated: number;
  stillPending: number;
};

/**
 * Backfills estimated/actual delivery dates for the on-time-delivery %
 * analytics (lib/analytics.ts's getOnTimeDeliveryStats) — see
 * lookupShipstationTracking's own comment (lib/shipstation.ts) for why this
 * is flagged unverified more strongly than the rest of the ShipStation
 * integration. Candidates require `shipstationCarrierCode` to already be
 * set (from the shipstation-labels cron), so this naturally lags one day
 * behind a brand-new scan rather than guessing a carrier code of its own.
 * Same resumable, oldest-checked-first shape as every other cron here.
 */
export async function runShipstationDeliveryCron(): Promise<ShipstationDeliveryCronResult> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const allRecent = await db
    .select()
    .from(scan)
    .where(
      and(
        isNotNull(scan.shipstationCarrierCode),
        isNull(scan.shipstationActualDeliveryAt),
        gt(scan.scannedAt, cutoff),
      ),
    );

  const pending = [...allRecent].sort((a, b) =>
    (a.shipstationDeliveryCheckedAt ?? "").localeCompare(b.shipstationDeliveryCheckedAt ?? ""),
  );
  const batch = pending.slice(0, MAX_LOOKUPS_PER_RUN);

  // TEMP: see lib/shipstation.ts's DIAG comment — confirming whether this
  // cron even reaches a ShipStation call. Revert once diagnosed.
  console.log(`[cron/shipstation-delivery][DIAG] allRecent=${allRecent.length} batch=${batch.length}`);

  if (batch.length === 0) {
    return { candidates: allRecent.length, checked: 0, updated: 0, stillPending: pending.length };
  }

  let updated = 0;
  const now = nowSqlTimestamp();
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_MS);
    const s = batch[i];
    // Guarded by the WHERE clause above, but TypeScript doesn't know that.
    if (!s.shipstationCarrierCode) continue;

    const tracking = await lookupShipstationTracking(s.shipstationCarrierCode, s.trackingNumber);

    if (!tracking || (!tracking.estimatedDeliveryAt && !tracking.actualDeliveryAt)) {
      await db.update(scan).set({ shipstationDeliveryCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }

    await db
      .update(scan)
      .set({
        // Never overwrite an estimate already on file with null — a carrier
        // can stop returning it on a later poll without that meaning the
        // earlier estimate is wrong.
        shipstationEstimatedDeliveryAt: tracking.estimatedDeliveryAt ?? s.shipstationEstimatedDeliveryAt,
        shipstationActualDeliveryAt: tracking.actualDeliveryAt ?? s.shipstationActualDeliveryAt,
        shipstationDeliveryCheckedAt: now,
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
