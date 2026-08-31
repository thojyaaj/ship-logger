"use server";

import { requireUser } from "@/lib/auth";
import { searchShipmentsForPalette, type ShipmentPaletteHit } from "@/lib/shiplog";

export async function searchShipmentsPaletteAction(query: string): Promise<ShipmentPaletteHit[]> {
  await requireUser();
  return searchShipmentsForPalette(query);
}
