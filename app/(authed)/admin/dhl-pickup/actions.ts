"use server";

import { requireAdmin } from "@/lib/auth";
import {
  saveDhlPickupSettings,
  clearDhlPickupHistory,
  type DhlPickupSettingsInput,
  type SettingsMutationResult,
} from "@/lib/dhl-pickup";

export async function saveDhlPickupSettingsAction(
  input: DhlPickupSettingsInput,
): Promise<SettingsMutationResult> {
  const admin = await requireAdmin();
  return saveDhlPickupSettings(input, admin.id);
}

export async function clearDhlPickupHistoryAction(): Promise<{ deleted: number }> {
  await requireAdmin();
  return clearDhlPickupHistory();
}
