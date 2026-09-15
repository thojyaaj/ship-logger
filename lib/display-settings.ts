import "server-only";
import { db } from "./db";
import { displaySettings } from "./db/schema";
import { eq } from "drizzle-orm";
import { nowSqlTimestamp } from "./date";

// One warehouse, one setting — a fixed-id singleton row, same convention as
// lib/dhl-pickup.ts's DHL_PICKUP settings.
const SETTINGS_ID = "default";

export type DisplaySettings = { boxesAsTabs: boolean; showOrderWeight: boolean };

/** Defaults to tabs + weight shown (the current behavior) when nothing's been configured yet — same "no row yet, default to the current behavior" convention as DHL pickup's `enabled` flag. */
export async function getDisplaySettings(): Promise<DisplaySettings> {
  const rows = await db.select().from(displaySettings).where(eq(displaySettings.id, SETTINGS_ID)).limit(1);
  return {
    boxesAsTabs: rows[0]?.boxesAsTabs ?? true,
    showOrderWeight: rows[0]?.showOrderWeight ?? true,
  };
}

export async function saveDisplaySettings(settings: DisplaySettings, updatedBy: string): Promise<void> {
  const now = nowSqlTimestamp();
  await db
    .insert(displaySettings)
    .values({ id: SETTINGS_ID, ...settings, updatedAt: now, updatedBy })
    .onConflictDoUpdate({ target: displaySettings.id, set: { ...settings, updatedAt: now, updatedBy } });
}
