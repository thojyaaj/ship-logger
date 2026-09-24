"use server";

import { requireUser, requireAdmin } from "@/lib/auth";
import {
  recordScan,
  undoScan,
  createBox,
  setActiveBox,
  removeEmptyBox,
  resolveScanOrders,
  resolveScanWeights,
  submitSession,
  reopenSession,
  resetSession,
  restoreReset,
  trashShipment,
  restoreShipment,
  type RecordScanResult,
  type SessionDashboard,
  type RestorableReset,
} from "@/lib/shiplog";
import type { Carrier } from "@/lib/carrier";
import { runExpectable, type ActionResult } from "@/lib/action-result";
import {
  draftSessionShipment,
  syncMasterUpsTracking,
  type SessionDraftState,
  type SyncMasterTrackingResult,
} from "@/lib/shipstation-epg-label";

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

/**
 * §9c.4 — fills in scans that were unmatched at scan time, for the poll in
 * ScanClient. Read-only and additive by construction (see resolveScanOrders),
 * so it needs no gate beyond "is signed in."
 */
export async function resolveScanOrdersAction(
  sessionId: string,
  scanIds: string[],
): Promise<Record<string, { orderGid: string; orderName: string }>> {
  await requireUser();
  // Same reasoning as validForceCarrier above: TypeScript's parameter types
  // are erased at the Server Action boundary, so a non-array (or an array of
  // non-strings) would reach inArray() and fail as a driver-level error
  // rather than a no-op.
  if (!Array.isArray(scanIds)) return {};
  return resolveScanOrders(
    sessionId,
    scanIds.filter((id): id is string => typeof id === "string"),
  );
}

/**
 * Same shape as resolveScanOrdersAction above, for the weight poll in
 * ScanClient — fills in a row's weight once recordScan's after() lookup has
 * written it, without the packer needing to reload the page.
 */
export async function resolveScanWeightsAction(
  sessionId: string,
  scanIds: string[],
): Promise<Record<string, number>> {
  await requireUser();
  if (!Array.isArray(scanIds)) return {};
  return resolveScanWeights(
    sessionId,
    scanIds.filter((id): id is string => typeof id === "string"),
  );
}

export async function undoScanAction(sessionId: string, scanId: string): Promise<ActionResult<SessionDashboard>> {
  await requireUser();
  return runExpectable(() => undoScan(sessionId, scanId));
}

export async function createBoxAction(sessionId: string): Promise<ActionResult<SessionDashboard>> {
  await requireUser();
  return runExpectable(() => createBox(sessionId));
}

export async function setActiveBoxAction(
  sessionId: string,
  boxId: string,
): Promise<ActionResult<SessionDashboard>> {
  await requireUser();
  return runExpectable(() => setActiveBox(sessionId, boxId));
}

export async function removeEmptyBoxAction(
  sessionId: string,
  boxId: string,
): Promise<ActionResult<SessionDashboard>> {
  await requireUser();
  return runExpectable(() => removeEmptyBox(sessionId, boxId));
}

/**
 * Step 1 of closing out an EPG shipment: drafts (never purchases) this
 * session's ShipStation shipment so a packer can open it there to weigh
 * each box and buy the label. See SubmitDialog.tsx, which calls this on
 * mount and idempotently retries it — draftSessionShipment itself is a
 * no-op if the session already has a shipstationShipmentId.
 */
export async function createMasterLabelDraftAction(sessionId: string): Promise<SessionDraftState> {
  await requireUser();
  return draftSessionShipment(sessionId);
}

/**
 * Step 2: polled from SubmitDialog.tsx every few seconds once a draft
 * exists, to pick up the master UPS tracking number the instant the label
 * is bought in ShipStation — see syncMasterUpsTracking's own comment for
 * why "earliest completed label" is the best-effort stand-in for a true
 * master tracking number.
 */
export async function syncMasterUpsTrackingAction(sessionId: string): Promise<SyncMasterTrackingResult> {
  await requireUser();
  return syncMasterUpsTracking(sessionId);
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

export async function reopenSessionAction(sessionId: string): Promise<ActionResult> {
  // Admin-only, like deleteShipment. Reopening a submitted shipment puts
  // already-shipped history back into an editable state, which is the same
  // class of capability — it was the one destructive-adjacent action still
  // reachable by any packer.
  const user = await requireAdmin();
  return runExpectable(() => reopenSession(sessionId, user.name));
}

export async function resetSessionAction(
  sessionId: string,
): Promise<ActionResult<{ dashboard: null; restore: RestorableReset }>> {
  const user = await requireUser();
  return runExpectable(() => resetSession(sessionId, user.id, user.name));
}

export async function restoreResetAction(resetId: string): Promise<ActionResult<SessionDashboard>> {
  await requireUser();
  return runExpectable(() => restoreReset(resetId));
}

export async function deleteShipmentAction(sessionId: string): Promise<ActionResult> {
  await requireAdmin();
  return runExpectable(() => trashShipment(sessionId));
}

export async function restoreShipmentAction(sessionId: string): Promise<void> {
  await requireAdmin();
  await restoreShipment(sessionId);
}
