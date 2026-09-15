"use server";

import { requireUser, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { shipmentSession } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ExpectedError } from "@/lib/expected-error";
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
 *
 * Returns the denial message if `user` may not manage this shipment's
 * pickup, or null if they may. A plain return value rather than a throw —
 * every caller already has an error variant in its own result union
 * (Next.js redacts a thrown Server Action error's message in production,
 * see lib/error-message.ts), so this folds straight into that instead of
 * needing a separate throw/catch conversion.
 */
async function checkCanManagePickup(sessionId: string, user: SessionUser): Promise<string | null> {
  if (user.isAdmin) return null;
  const rows = await db
    .select({ submittedBy: shipmentSession.submittedBy })
    .from(shipmentSession)
    .where(eq(shipmentSession.id, sessionId))
    .limit(1);
  if (rows[0]?.submittedBy !== user.id) {
    return "You can only manage DHL pickups for shipments you submitted.";
  }
  return null;
}

export async function previewPickupAction(sessionId: string): Promise<PreviewPickupResult> {
  const user = await requireUser();
  const denied = await checkCanManagePickup(sessionId, user);
  if (denied) return { status: "error", message: denied };
  return previewPickupForSession(sessionId);
}

export async function schedulePickupAction(sessionId: string): Promise<SchedulePickupResult> {
  const user = await requireUser();
  const denied = await checkCanManagePickup(sessionId, user);
  if (denied) return { status: "error", message: denied };
  return schedulePickupForSession(sessionId, user.id, user.name);
}

export async function cancelPickupAction(sessionId: string): Promise<CancelPickupResult> {
  const user = await requireUser();
  const denied = await checkCanManagePickup(sessionId, user);
  if (denied) return { status: "error", message: denied };
  return cancelPickupForSession(sessionId, user.id, user.name);
}

export async function getLatestPickupRequestAction(
  sessionId: string,
): Promise<PickupRequestRecord | null> {
  const user = await requireUser();
  const denied = await checkCanManagePickup(sessionId, user);
  if (denied) throw new ExpectedError(denied);
  return getLatestPickupRequest(sessionId);
}
