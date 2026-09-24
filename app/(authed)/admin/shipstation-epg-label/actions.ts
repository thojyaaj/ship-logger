"use server";

import { requireAdmin } from "@/lib/auth";
import {
  saveShipstationEpgLabelSettings,
  type ShipstationEpgLabelSettingsInput,
  type SettingsMutationResult,
} from "@/lib/shipstation-epg-label";

export async function saveShipstationEpgLabelSettingsAction(
  input: ShipstationEpgLabelSettingsInput,
): Promise<SettingsMutationResult> {
  const admin = await requireAdmin();
  return saveShipstationEpgLabelSettings(input, admin.id);
}
