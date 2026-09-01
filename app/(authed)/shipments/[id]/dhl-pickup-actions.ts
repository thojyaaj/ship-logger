"use server";

import { requireAdmin } from "@/lib/auth";
import {
  previewPickupForSession,
  schedulePickupForSession,
  cancelPickupForSession,
  getLatestPickupRequest,
  type PreviewPickupResult,
  type SchedulePickupResult,
  type CancelPickupResult,
  type PickupRequestRecord,
} from "@/lib/dhl-pickup";

export async function previewPickupAction(sessionId: string): Promise<PreviewPickupResult> {
  await requireAdmin();
  return previewPickupForSession(sessionId);
}

export async function schedulePickupAction(sessionId: string): Promise<SchedulePickupResult> {
  const admin = await requireAdmin();
  return schedulePickupForSession(sessionId, admin.id);
}

export async function cancelPickupAction(sessionId: string): Promise<CancelPickupResult> {
  const admin = await requireAdmin();
  return cancelPickupForSession(sessionId, admin.id, admin.name);
}

export async function getLatestPickupRequestAction(
  sessionId: string,
): Promise<PickupRequestRecord | null> {
  await requireAdmin();
  return getLatestPickupRequest(sessionId);
}
