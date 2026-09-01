"use server";

import { requireAdmin } from "@/lib/auth";
import {
  saveDhlPickupSettings,
  type DhlPickupSettingsInput,
  type SettingsMutationResult,
} from "@/lib/dhl-pickup";

export async function saveDhlPickupSettingsAction(
  input: DhlPickupSettingsInput,
): Promise<SettingsMutationResult> {
  const admin = await requireAdmin();
  return saveDhlPickupSettings(input, admin.id);
}
