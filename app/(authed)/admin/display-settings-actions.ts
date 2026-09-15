"use server";

import { requireAdmin } from "@/lib/auth";
import { saveDisplaySettings, type DisplaySettings } from "@/lib/display-settings";

export async function saveDisplaySettingsAction(settings: DisplaySettings): Promise<void> {
  const admin = await requireAdmin();
  await saveDisplaySettings(settings, admin.id);
}
