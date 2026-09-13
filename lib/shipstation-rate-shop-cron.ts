import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { lookupShipstationShipment } from "./shipstation";
import { estimateBestRate } from "./shipstation-rates";
import { getDhlPickupSettings } from "./dhl-pickup";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";

const LOOKBACK_DAYS = 45;
const RATE_LIMIT_MS = 350;
// Half the usual batch size — each scan here costs two ShipStation calls
// (a shipment lookup for the destination, then the rate estimate itself),
// not one, so this keeps the same real time/quota budget as the other crons.
const MAX_LOOKUPS_PER_RUN = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ShipstationRateShopCronResult = {
  candidates: number;
  checked: number;
  updated: number;
  stillPending: number;
  /** True when DHL pickup settings (reused as the warehouse's one origin address) aren't configured yet — nothing to compare from, so the cron no-ops entirely. */
  skippedNoOrigin: boolean;
};

/**
 * Backfills a "what this would have cost elsewhere" quote per parcel, for
 * the rate-shop savings analytics (lib/analytics.ts's getRateShopSavings).
 * Reuses `getDhlPickupSettings()`'s address as the ship-from — not
 * DHL-specific data, just the one physical warehouse address this app
 * already has on file (see lib/dhl-pickup.ts) — and
 * lib/shipstation.ts's lookupShipstationShipment for the ship-to, the same
 * call the order-fallback cron already makes for a different reason. Only
 * considers scans with real weight/dimensions already backfilled (Section 0
 * — lib/shipstation-cron.ts), so this naturally runs after that cron has
 * caught up. Same unverified-endpoint caveat as lib/shipstation-rates.ts.
 */
export async function runShipstationRateShopCron(): Promise<ShipstationRateShopCronResult> {
  const settings = await getDhlPickupSettings();
  // TEMP: see lib/shipstation.ts's DIAG comment. Revert once diagnosed.
  console.log(`[cron/shipstation-rate-shop][DIAG] settingsConfigured=${settings !== null}`);
  if (!settings) {
    return { candidates: 0, checked: 0, updated: 0, stillPending: 0, skippedNoOrigin: true };
  }

  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const allRecent = await db
    .select()
    .from(scan)
    .where(
      and(
        isNotNull(scan.shipstationWeightLb),
        isNull(scan.shipstationBestRateCheckedAt),
        gt(scan.scannedAt, cutoff),
      ),
    );

  const pending = [...allRecent].sort((a, b) =>
    (a.shipstationBestRateCheckedAt ?? "").localeCompare(b.shipstationBestRateCheckedAt ?? ""),
  );
  const batch = pending.slice(0, MAX_LOOKUPS_PER_RUN);

  console.log(`[cron/shipstation-rate-shop][DIAG] allRecent=${allRecent.length} batch=${batch.length}`);

  if (batch.length === 0) {
    return { candidates: allRecent.length, checked: 0, updated: 0, stillPending: pending.length, skippedNoOrigin: false };
  }

  let updated = 0;
  const now = nowSqlTimestamp();
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_MS);
    const s = batch[i];

    const shipment = await lookupShipstationShipment(s.trackingNumber);
    if (!shipment?.shipToCountryCode || !shipment.shipToPostalCode) {
      await db.update(scan).set({ shipstationBestRateCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }

    await sleep(RATE_LIMIT_MS);
    const best = await estimateBestRate({
      fromCountryCode: settings.countryCode,
      fromPostalCode: settings.postalCode,
      toCountryCode: shipment.shipToCountryCode,
      toPostalCode: shipment.shipToPostalCode,
      toCityLocality: shipment.shipToCityLocality,
      toStateProvince: shipment.shipToStateProvince,
      // Guarded by the WHERE clause above (shipstationWeightLb IS NOT NULL,
      // and all four measurement columns are always written together — see
      // that column's comment in lib/db/schema.ts).
      weightLb: s.shipstationWeightLb!,
      lengthIn: s.shipstationLengthIn!,
      widthIn: s.shipstationWidthIn!,
      heightIn: s.shipstationHeightIn!,
    });

    if (!best) {
      await db.update(scan).set({ shipstationBestRateCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }

    await db
      .update(scan)
      .set({
        shipstationBestRateAmount: best.amount,
        shipstationBestRateCarrier: best.carrierCode,
        shipstationBestRateCheckedAt: now,
      })
      .where(eq(scan.id, s.id));
    updated += 1;
  }

  return {
    candidates: allRecent.length,
    checked: batch.length,
    updated,
    stillPending: pending.length - updated,
    skippedNoOrigin: false,
  };
}
