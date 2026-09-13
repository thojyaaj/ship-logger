/**
 * One-time cleanup: wipes every row from `dhl_pickup_request` (the pickup
 * requested/cancelled/failed history behind Analytics' "DHL pickups" tile
 * and getDhlPickupStats' cancel-rate ratio). Every row in that table today
 * came from manually testing pickup scheduling/cancellation while building
 * the feature — not real warehouse usage — so the analytics page was
 * showing a "80% cancelled" rate that was actually just test noise. Real
 * pickup requests going forward are unaffected; this only clears history.
 *
 * Usage: npx tsx scripts/clear-dhl-pickup-test-data.ts
 */
process.loadEnvFile?.(".env.local");

import { db } from "../lib/db";
import { dhlPickupRequest } from "../lib/db/schema";

async function main() {
  const existing = await db.select({ id: dhlPickupRequest.id }).from(dhlPickupRequest);
  console.log(`Deleting ${existing.length} dhl_pickup_request row(s)...`);
  if (existing.length === 0) {
    console.log("Nothing to delete.");
    return;
  }
  await db.delete(dhlPickupRequest);
  console.log("Done.");
}

main().then(() => process.exit(0));
