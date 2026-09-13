"use server";

import { requireAdmin } from "@/lib/auth";
import { saveDisplaySettings } from "@/lib/display-settings";

export async function saveDisplaySettingsAction(boxesAsTabs: boolean): Promise<void> {
  const admin = await requireAdmin();
  await saveDisplaySettings(boxesAsTabs, admin.id);
}
