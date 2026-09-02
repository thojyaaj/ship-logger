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
  trashShipment,
  restoreShipment,
  type RecordScanResult,
  type SessionDashboard,
} from "@/lib/shiplog";
import type { Carrier } from "@/lib/carrier";

// Carriers a packer may manually assign to an unrecognized scan. TypeScript's
// `Carrier` type is erased at the Server Action boundary and the `carrier`
// column is plain `text` with no CHECK constraint, so an arbitrary string
// would persist happily — and every `totals[scan.carrier] += 1` in the
// dashboard, list, and chart queries would then produce NaN for that session.
// "unknown" is excluded on purpose: it's a detection outcome, not an
// assignment the UI ever offers.
const ASSIGNABLE_CARRIERS = new Set<Carrier>(["epg", "ups", "dhl"]);

function validForceCarrier(value: unknown): Carrier | undefined {
  return typeof value === "string" && ASSIGNABLE_CARRIERS.has(value as Carrier)
    ? (value as Carrier)
    : undefined;
}

export async function scanAction(
  sessionId: string | null,
  rawTrackingNumber: string,
  opts?: { forceCarrier?: Carrier; overrideChecksum?: boolean; forcePastDuplicate?: boolean },
): Promise<RecordScanResult> {
  const user = await requireUser();
  return recordScan({
    sessionId,
    userId: user.id,
    rawTrackingNumber,
    forceCarrier: validForceCarrier(opts?.forceCarrier),
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
  // Admin-only, like deleteShipment. Reopening a submitted shipment puts
  // already-shipped history back into an editable state, which is the same
  // class of capability — it was the one destructive-adjacent action still
  // reachable by any packer.
  const user = await requireAdmin();
  await reopenSession(sessionId, user.name);
}

export async function resetSessionAction(sessionId: string): Promise<SessionDashboard | null> {
  const user = await requireUser();
  return resetSession(sessionId, user.name);
}

export async function deleteShipmentAction(sessionId: string): Promise<void> {
  await requireAdmin();
  await trashShipment(sessionId);
}

export async function restoreShipmentAction(sessionId: string): Promise<void> {
  await requireAdmin();
  await restoreShipment(sessionId);
}
