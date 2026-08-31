"use server";

import { requireUser, requireAdmin } from "@/lib/auth";
import {
  recordScan,
  undoScan,
  createBox,
  setActiveBox,
  removeEmptyBox,
  submitSession,
  reopenSession,
  resetSession,
  deleteShipment,
  type RecordScanResult,
  type SessionDashboard,
} from "@/lib/shiplog";
import type { Carrier } from "@/lib/carrier";

export async function scanAction(
  sessionId: string,
  rawTrackingNumber: string,
  opts?: { forceCarrier?: Carrier; overrideChecksum?: boolean; forcePastDuplicate?: boolean },
): Promise<RecordScanResult> {
  const user = await requireUser();
  return recordScan({
    sessionId,
    userId: user.id,
    rawTrackingNumber,
    forceCarrier: opts?.forceCarrier,
    overrideChecksum: opts?.overrideChecksum,
    // Only admins may push a scan past the previous-shipment duplicate block (§8.4b).
    forcePastDuplicate: opts?.forcePastDuplicate && user.isAdmin,
  });
}

export async function undoScanAction(sessionId: string, scanId: string): Promise<SessionDashboard> {
  await requireUser();
  return undoScan(sessionId, scanId);
}

export async function createBoxAction(sessionId: string): Promise<SessionDashboard> {
  await requireUser();
  return createBox(sessionId);
}

export async function setActiveBoxAction(sessionId: string, boxId: string): Promise<SessionDashboard> {
  await requireUser();
  return setActiveBox(sessionId, boxId);
}

export async function removeEmptyBoxAction(sessionId: string, boxId: string): Promise<SessionDashboard> {
  await requireUser();
  return removeEmptyBox(sessionId, boxId);
}

export async function submitSessionAction(input: {
  sessionId: string;
  awbNumber: string;
  masterUpsTracking: string;
  shipDate: string;
  notes: string;
  boxUpsTracking: Record<string, string>;
}) {
  const user = await requireUser();
  return submitSession({ ...input, userId: user.id });
}

export async function reopenSessionAction(sessionId: string): Promise<void> {
  const user = await requireUser();
  await reopenSession(sessionId, user.name);
}

export async function resetSessionAction(sessionId: string): Promise<SessionDashboard> {
  const user = await requireUser();
  return resetSession(sessionId, user.id, user.name);
}

export async function deleteShipmentAction(sessionId: string): Promise<void> {
  await requireAdmin();
  await deleteShipment(sessionId);
}
