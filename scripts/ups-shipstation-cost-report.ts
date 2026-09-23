/**
 * UPS billing report, sourced from ShipStation's per-label cost data
 * (`scan.shipstationCostAmount`, backfilled for every carrier by
 * lib/shipstation-cron.ts — see lib/analytics.ts's getCostStats for the
 * same field used in the in-app Analytics page).
 *
 * ShipStation returns one total cost per label — there is no separate
 * "other costs" line item stored anywhere in this app's schema (no fuel
 * surcharge, residential fee, etc. broken out). `shipstationCostAmount` is
 * that one total, so this report has a single Cost column, not a
 * label-cost-vs-other-costs split.
 *
 * Usage: npx tsx scripts/ups-shipstation-cost-report.ts [--days 90] [--csv out.csv]
 */
process.loadEnvFile?.(".env.local");

import { db } from "../lib/db";
import { scan, shipmentSession } from "../lib/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { localCalendarDate } from "../lib/date";
import { writeFileSync } from "fs";

const daysArgIndex = process.argv.indexOf("--days");
const DAYS = daysArgIndex >= 0 ? Number(process.argv[daysArgIndex + 1]) : 90;
const csvArgIndex = process.argv.indexOf("--csv");
const CSV_PATH = csvArgIndex >= 0 ? process.argv[csvArgIndex + 1] : null;

function calendarCutoff(days: number): string {
  return localCalendarDate(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
}

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const cutoff = calendarCutoff(DAYS);
  const rows = await db
    .select({
      trackingNumber: scan.trackingNumber,
      orderName: scan.orderName,
      shipDate: shipmentSession.shipDate,
      cost: scan.shipstationCostAmount,
      currency: scan.shipstationCostCurrency,
      shipstationCarrierCode: scan.shipstationCarrierCode,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(
        eq(scan.carrier, "ups"),
        eq(shipmentSession.status, "submitted"),
        isNull(shipmentSession.deletedAt),
        sql`${shipmentSession.shipDate} >= ${cutoff}`,
      ),
    )
    .orderBy(shipmentSession.shipDate);

  const priced = rows.filter((r) => r.cost !== null);
  const unpriced = rows.filter((r) => r.cost === null);
  const totalCost = priced.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const currency = priced.find((r) => r.currency)?.currency ?? null;

  console.log(`UPS parcels shipped since ${cutoff}: ${rows.length}`);
  console.log(`  with a ShipStation cost recorded: ${priced.length}`);
  console.log(`  no cost yet (label not backfilled): ${unpriced.length}`);
  console.log(`Total billed (ShipStation): ${currency ?? ""} ${totalCost.toFixed(2)}`);
  console.log(`Average per parcel: ${currency ?? ""} ${priced.length > 0 ? (totalCost / priced.length).toFixed(2) : "n/a"}`);

  if (CSV_PATH) {
    const header = ["Ship Date", "Tracking Number", "Order", "Cost", "Currency"].join(",");
    const lines = rows.map((r) =>
      [
        csvCell(r.shipDate),
        csvCell(r.trackingNumber),
        csvCell(r.orderName),
        csvCell(r.cost !== null ? r.cost.toFixed(2) : ""),
        csvCell(r.currency),
      ].join(","),
    );
    lines.push(["TOTAL", "", "", totalCost.toFixed(2), currency ?? ""].join(","));
    writeFileSync(CSV_PATH, [header, ...lines].join("\n") + "\n");
    console.log(`Wrote ${rows.length} row(s) to ${CSV_PATH}`);
  }
}

main().then(() => process.exit(0));
