"use server";

import { requireUser, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { shipmentSession } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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

/**
 * Admins can manage pickup for any shipment (matches the shipment detail
 * page's admin panel). A non-admin is scoped to shipments they themselves
 * submitted — otherwise relaxing this off admin-only would let any packer
 * schedule or cancel a real DHL truck for a shipment they had nothing to do
 * with.
 */
async function assertCanManagePickup(sessionId: string, user: SessionUser): Promise<void> {
  if (user.isAdmin) return;
  const rows = await db
    .select({ submittedBy: shipmentSession.submittedBy })
    .from(shipmentSession)
    .where(eq(shipmentSession.id, sessionId))
    .limit(1);
  if (rows[0]?.submittedBy !== user.id) {
    throw new Error("You can only manage DHL pickups for shipments you submitted.");
  }
}

export async function previewPickupAction(sessionId: string): Promise<PreviewPickupResult> {
  const user = await requireUser();
  await assertCanManagePickup(sessionId, user);
  return previewPickupForSession(sessionId);
}

export async function schedulePickupAction(sessionId: string): Promise<SchedulePickupResult> {
  const user = await requireUser();
  await assertCanManagePickup(sessionId, user);
  return schedulePickupForSession(sessionId, user.id, user.name);
}

export async function cancelPickupAction(sessionId: string): Promise<CancelPickupResult> {
  const user = await requireUser();
  await assertCanManagePickup(sessionId, user);
  return cancelPickupForSession(sessionId, user.id, user.name);
}

export async function getLatestPickupRequestAction(
  sessionId: string,
): Promise<PickupRequestRecord | null> {
  const user = await requireUser();
  await assertCanManagePickup(sessionId, user);
  return getLatestPickupRequest(sessionId);
}
