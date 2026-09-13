"use server";

import { requireAdmin, requireSuperAdmin } from "@/lib/auth";
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

// Superadmin-gated — an irreversible full wipe of pickup history, not a
// day-to-day admin control (see lib/auth.ts's requireSuperAdmin).
export async function clearDhlPickupHistoryAction(): Promise<{ deleted: number }> {
  await requireSuperAdmin();
  return clearDhlPickupHistory();
}
