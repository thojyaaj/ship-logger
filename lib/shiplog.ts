import "server-only";
import { db } from "./db";
import { appUser, shipmentSession, box, scan, shipmentReset } from "./db/schema";
import { and, eq, desc, sql, ne, inArray, ilike, or, isNull, isNotNull, lt, gt } from "drizzle-orm";
import { newId } from "./id";
import { detectCarrier, type Carrier } from "./carrier";
import { nowSqlTimestamp, localCalendarDate, toSqlTimestamp, parseDbTimestamp } from "./date";
import { lookupOrderIndex } from "./order-index";

function today(): string {
  return localCalendarDate();
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Distinguishes "this shipment id doesn't exist" from "the database is down".
 * Callers used to `catch {}` every error into a 404, so a connection failure
 * rendered as a clean "not found" page — hiding a real outage behind a result
 * that looks like normal, expected behaviour.
 */
export class ShipmentNotFoundError extends Error {}

export type BoxSummary = {
  id: string;
  boxNumber: number;
  upsTracking: string | null;
  scanCount: number;
};

export type ScanRow = {
  id: string;
  trackingNumber: string;
  carrier: Carrier;
  boxId: string | null;
  boxNumber: number | null;
  scannedBy: string;
  scannedAt: string;
  sequence: number;
  orderGid: string | null;
  orderName: string | null;
  epgExternalRef: string | null;
  epgFinalMile: string | null;
  statusLabel: string | null;
  statusAt: string | null;
};

export type SessionDashboard = {
  session: typeof shipmentSession.$inferSelect;
  boxes: BoxSummary[];
  scans: ScanRow[];
  totals: { epg: number; ups: number; dhl: number; unknown: number; total: number };
  userNames: Record<string, string>;
  userCodes: Record<string, string>;
};

const RESET_RESTORE_WINDOW_MS = 30 * 60 * 1000;
type ResetSnapshot = { session: typeof shipmentSession.$inferSelect; boxes: (typeof box.$inferSelect)[]; scans: (typeof scan.$inferSelect)[] };
export type RestorableReset = { id: string; expiresAt: string; scanCount: number };

async function loadDashboard(sessionId: string): Promise<SessionDashboard> {
  const sessionRows = await db
    .select()
    .from(shipmentSession)
    .where(eq(shipmentSession.id, sessionId))
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new ShipmentNotFoundError("Session not found.");

  const boxRows = await db.select().from(box).where(eq(box.sessionId, sessionId));
  const scanRows = await db
    .select()
    .from(scan)
    .where(eq(scan.sessionId, sessionId))
    .orderBy(desc(scan.sequence));

  const boxCounts = new Map<string, number>();
  for (const s of scanRows) {
    if (s.boxId) boxCounts.set(s.boxId, (boxCounts.get(s.boxId) ?? 0) + 1);
  }

  const boxNumberById = new Map(boxRows.map((b) => [b.id, b.boxNumber]));

  const boxes: BoxSummary[] = boxRows
    .sort((a, b) => a.boxNumber - b.boxNumber)
    .map((b) => ({
      id: b.id,
      boxNumber: b.boxNumber,
      upsTracking: b.upsTracking,
      scanCount: boxCounts.get(b.id) ?? 0,
    }));

  const scans: ScanRow[] = scanRows.map((s) => ({
    id: s.id,
    trackingNumber: s.trackingNumber,
    carrier: s.carrier as Carrier,
    boxId: s.boxId,
    boxNumber: s.boxId ? (boxNumberById.get(s.boxId) ?? null) : null,
    scannedBy: s.scannedBy,
    scannedAt: s.scannedAt,
    sequence: s.sequence,
    orderGid: s.orderGid,
    orderName: s.orderName,
    epgExternalRef: s.epgExternalRef,
    epgFinalMile: s.epgFinalMile,
    statusLabel: s.statusLabel,
    statusAt: s.statusAt,
  }));

  const totals = { epg: 0, ups: 0, dhl: 0, unknown: 0, total: scans.length };
  for (const s of scans) totals[s.carrier] += 1;

  // The submitter may not be among the scan rows (for example, a lead can
  // close out a shipment another packer scanned), so include them explicitly
  // for lookups keyed off session.submittedBy (e.g. the packer-code suffix
  // shown on the shipment's short ID).
  const userIds = [...new Set([...scans.map((s) => s.scannedBy), ...(session.submittedBy ? [session.submittedBy] : [])])];
  const userNames: Record<string, string> = {};
  const userCodes: Record<string, string> = {};
  if (userIds.length > 0) {
    const users = await db.select().from(appUser).where(inArray(appUser.id, userIds));
    for (const u of users) {
      userNames[u.id] = u.name;
      if (u.packerCode) userCodes[u.id] = u.packerCode;
    }
  }

  return { session, boxes, scans, totals, userNames, userCodes };
}

/**
 * `%` and `_` are wildcards inside a LIKE/ILIKE pattern. Values searched here
 * are user-typed tracking numbers and AWBs, so they must match literally.
 * Backslash is Postgres's default LIKE escape character and has to be escaped
 * first, or it would escape the escapes we add.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === POSTGRES_UNIQUE_VIOLATION;
}

/**
 * Reads the single shared open session, if one exists — never creates one.
 * A shipment-day row isn't created until the first scan actually commits
 * (see `recordScan`/`createOpenSessionRow`), so a packer who opens the scan
 * page without scanning anything never leaves an OPEN row on the Shipments
 * Log.
 */
export async function getOpenSession(): Promise<SessionDashboard | null> {
  const openRows = await db
    .select()
    .from(shipmentSession)
    .where(eq(shipmentSession.status, "open"))
    .orderBy(desc(shipmentSession.openedAt))
    .limit(1);
  if (!openRows[0]) return null;
  return loadDashboard(openRows[0].id);
}

/**
 * Creates the shared open session row. Only called from `recordScan`, right
 * before the first scan of the day actually commits.
 *
 * Two packers scanning the day's first parcel at the same moment could both
 * see zero open sessions and both try to create one. The partial unique
 * index on `status = 'open'` (migration 0003) makes the database reject the
 * loser's INSERT instead of silently creating two open sessions — that
 * loser then just re-reads and adopts whichever session actually won, same
 * as if it had seen it up front.
 */
async function createOpenSessionRow(userId: string): Promise<typeof shipmentSession.$inferSelect> {
  const id = newId();
  try {
    await db.insert(shipmentSession).values({
      id,
      openedBy: userId,
      shipDate: today(),
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await db
      .select()
      .from(shipmentSession)
      .where(eq(shipmentSession.status, "open"))
      .orderBy(desc(shipmentSession.openedAt))
      .limit(1);
    if (!winner[0]) throw err; // shouldn't happen, but don't swallow a real error
    return winner[0];
  }
  const created = (await db.select().from(shipmentSession).where(eq(shipmentSession.id, id)))[0];
  if (!created) throw new Error("Failed to load newly created session.");
  return created;
}

export async function createBox(sessionId: string): Promise<SessionDashboard> {
  const session = (await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)))[0];
  if (!session || session.status !== "open") throw new Error("Session is not open.");

  const existing = await db.select().from(box).where(eq(box.sessionId, sessionId));
  const nextNumber = existing.reduce((max, b) => Math.max(max, b.boxNumber), 0) + 1;

  const id = newId();
  await db.insert(box).values({ id, sessionId, boxNumber: nextNumber });
  await db.update(shipmentSession).set({ activeBoxId: id }).where(eq(shipmentSession.id, sessionId));

  return loadDashboard(sessionId);
}

export async function setActiveBox(sessionId: string, boxId: string): Promise<SessionDashboard> {
  const target = (await db.select().from(box).where(eq(box.id, boxId)))[0];
  if (!target || target.sessionId !== sessionId) throw new Error("Box not found in this session.");
  await db.update(shipmentSession).set({ activeBoxId: boxId }).where(eq(shipmentSession.id, sessionId));
  return loadDashboard(sessionId);
}

export type RecordScanInput = {
  /** null before the day's first scan — the open session doesn't exist yet. */
  sessionId: string | null;
  userId: string;
  rawTrackingNumber: string;
  forceCarrier?: Carrier;
  overrideChecksum?: boolean;
  /** Admin-only escape hatch past the previous-shipment duplicate block (§8.4b). */
  forcePastDuplicate?: boolean;
};

export type RecordScanResult =
  | { status: "ok"; dashboard: SessionDashboard; carrier: Carrier; boxNumber: number | null }
  | { status: "unrecognized"; trackingNumber: string }
  | { status: "checksum_warning"; trackingNumber: string; carrier: Carrier; reason: string }
  | {
      status: "duplicate_in_session";
      trackingNumber: string;
      boxNumber: number | null;
      carrier: Carrier;
      /**
       * Current server state. recordScan is not idempotent but the client
       * retries it on transport failures, so a first attempt that committed
       * and then lost its response comes back here as a "duplicate". Returning
       * the dashboard lets the client show the scan that really was recorded
       * instead of silently dropping it from the manifest.
       */
      dashboard: SessionDashboard;
    }
  | {
      status: "duplicate_previous_shipment";
      trackingNumber: string;
      shipDate: string;
      boxNumber: number | null;
      scannedByName: string;
      sessionSubmitted: boolean;
    };

export async function recordScan(input: RecordScanInput): Promise<RecordScanResult> {
  const detection = detectCarrier(input.rawTrackingNumber);
  const trackingNumber = detection.trackingNumber;
  const finalCarrier: Carrier = input.forceCarrier ?? detection.carrier;

  if (finalCarrier === "unknown") {
    return { status: "unrecognized", trackingNumber };
  }

  if (
    !input.forceCarrier &&
    !input.overrideChecksum &&
    detection.carrier !== "unknown" &&
    !detection.checksumValid
  ) {
    return {
      status: "checksum_warning",
      trackingNumber,
      carrier: detection.carrier,
      reason: detection.reason ?? "Check digit failed.",
    };
  }

  const existingRows = await db
    .select({
      id: scan.id,
      sessionId: scan.sessionId,
      boxId: scan.boxId,
      scannedBy: scan.scannedBy,
    })
    .from(scan)
    .where(eq(scan.trackingNumber, trackingNumber))
    .limit(1);
  const existing = existingRows[0];

  let resolvedSession: typeof shipmentSession.$inferSelect | null = null;
  // A scan committing is the only thing that creates today's shipment-day
  // row (see `createOpenSessionRow`) — so this resolves the existing open
  // session if one was passed in, or creates it right here, the moment a
  // scan is actually about to be recorded. Memoized because both the
  // admin-override branch below and the normal path after it need the same
  // resolved session.
  async function resolveSession(): Promise<typeof shipmentSession.$inferSelect> {
    if (resolvedSession) return resolvedSession;
    if (input.sessionId) {
      const found = (
        await db.select().from(shipmentSession).where(eq(shipmentSession.id, input.sessionId))
      )[0];
      if (!found || found.status !== "open") throw new Error("Session is not open.");
      resolvedSession = found;
    } else {
      resolvedSession = await createOpenSessionRow(input.userId);
    }
    return resolvedSession;
  }

  if (existing) {
    if (existing.sessionId === input.sessionId) {
      const existingBox = existing.boxId
        ? (await db.select().from(box).where(eq(box.id, existing.boxId)))[0]
        : null;
      return {
        status: "duplicate_in_session",
        trackingNumber,
        boxNumber: existingBox?.boxNumber ?? null,
        carrier: finalCarrier,
        dashboard: await loadDashboard(input.sessionId),
      };
    }

    if (!input.forcePastDuplicate) {
      const otherSession = (
        await db.select().from(shipmentSession).where(eq(shipmentSession.id, existing.sessionId))
      )[0];
      const otherBox = existing.boxId
        ? (await db.select().from(box).where(eq(box.id, existing.boxId)))[0]
        : null;
      const scannedByUser = (
        await db.select().from(appUser).where(eq(appUser.id, existing.scannedBy))
      )[0];

      return {
        status: "duplicate_previous_shipment",
        trackingNumber,
        shipDate: otherSession?.shipDate ?? "unknown date",
        boxNumber: otherBox?.boxNumber ?? null,
        scannedByName: scannedByUser?.name ?? "unknown",
        sessionSubmitted: otherSession?.status === "submitted",
      };
    }

    // Admin override: the old row is deleted so the unique constraint on
    // tracking_number can be satisfied by the new one. The record of it
    // having shipped before only lived in that other session's row anyway.
    //
    // The session-open check has to happen BEFORE this delete. It used to run
    // a few lines below, which meant overriding into a non-open session
    // destroyed the prior shipment's record and *then* threw — the parcel's
    // history was gone and nothing replaced it.
    await resolveSession();
    await db.delete(scan).where(eq(scan.id, existing.id));
  }

  const session = await resolveSession();

  let boxId: string | null = null;
  let boxNumber: number | null = null;
  if (finalCarrier === "epg") {
    let activeBox = session.activeBoxId
      ? (await db.select().from(box).where(eq(box.id, session.activeBoxId)))[0]
      : undefined;
    if (!activeBox) {
      const existingBoxes = await db.select().from(box).where(eq(box.sessionId, session.id));
      const nextNumber = existingBoxes.reduce((max, b) => Math.max(max, b.boxNumber), 0) + 1;
      const id = newId();
      try {
        await db.insert(box).values({ id, sessionId: session.id, boxNumber: nextNumber });
        await db
          .update(shipmentSession)
          .set({ activeBoxId: id })
          .where(eq(shipmentSession.id, session.id));
        activeBox = { id, sessionId: session.id, boxNumber: nextNumber, upsTracking: null };
      } catch (err) {
        // Two packers scanning the day's first EPG parcel at the same instant
        // both read activeBoxId=null and both compute box 1; the unique index
        // on (session_id, box_number) rejects the loser. That rejection used
        // to propagate out of recordScan *before* the scan row was inserted —
        // so the parcel was physically in the box with no record of it, the
        // worst possible outcome here. Adopt the box the winner created.
        if (!isUniqueViolation(err)) throw err;
        const winner = (
          await db
            .select()
            .from(box)
            .where(and(eq(box.sessionId, session.id), eq(box.boxNumber, nextNumber)))
        )[0];
        if (!winner) throw err;
        activeBox = winner;
      }
    }
    boxId = activeBox.id;
    boxNumber = activeBox.boxNumber;
  }

  // Highest sequence so far, not count(*). With count(*) the number was reused
  // after any undo — scan three parcels (1,2,3), undo #2, and the next scan
  // computed count=2 → sequence 3, colliding with the existing #3. There is no
  // unique index on (session_id, sequence) to catch it, and loadDashboard
  // orders by sequence, so two parcels rendered as the same number in an
  // arbitrary order. max()+1 is monotonic across undos and matches how box
  // numbers are already allocated.
  //
  // postgres-js returns aggregates as strings (bigint-safe) — Number() before
  // arithmetic or string concatenation silently misbehaves. max() is null on
  // an empty session, hence the ?? 0.
  const maxRow = await db
    .select({ max: sql<number | null>`max(${scan.sequence})` })
    .from(scan)
    .where(eq(scan.sessionId, session.id));
  const sequence = Number(maxRow[0]?.max ?? 0) + 1;

  // §9c: a local, no-network lookup against the webhook-fed index (§9b) —
  // never a live Shopify call at scan time.
  //
  // Now runs for EPG too, not just UPS/DHL. EPG used to be excluded on the
  // assumption its orders could only be reached via `epg_external_ref`, which
  // isn't known until EPG ingests the label — and since parcels are scanned at
  // the packing desk *before* the consolidated shipment physically ships, that
  // left every EPG scan with a blank order number for days, sometimes forever.
  // But this store's Shopify fulfilments carry the EPG tracking number, and the
  // webhook indexes every tracking number on a fulfilment regardless of
  // carrier, so the answer is already sitting in the local index at scan time.
  // A carrier the index doesn't know simply misses and returns null, so there
  // is no downside to asking for all of them.
  const orderMatch = await lookupOrderIndex(trackingNumber);

  await db.insert(scan).values({
    id: newId(),
    sessionId: session.id,
    boxId,
    scannedBy: input.userId,
    trackingNumber,
    carrier: finalCarrier,
    sequence,
    orderGid: orderMatch?.orderGid,
    orderName: orderMatch?.orderName,
  });

  const dashboard = await loadDashboard(session.id);
  return { status: "ok", dashboard, carrier: finalCarrier, boxNumber };
}

/**
 * Editing history is an admin-only capability (deleteShipment is gated behind
 * requireAdmin). The per-scan/per-box edit actions are only requireUser, so
 * they must refuse to touch a session that is no longer open — otherwise any
 * packer can open a *submitted* shipment, read every scan id straight out of
 * the RSC payload, and undo them one by one to empty it, reaching the same
 * destructive end state the admin gate exists to prevent.
 */
async function assertSessionOpen(sessionId: string): Promise<void> {
  const session = (
    await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId))
  )[0];
  if (!session) throw new Error("Shipment not found.");
  if (session.status !== "open") {
    throw new Error("This shipment is no longer open — reopen it before editing.");
  }
}

export async function undoScan(sessionId: string, scanId: string): Promise<SessionDashboard> {
  await assertSessionOpen(sessionId);
  const target = (await db.select().from(scan).where(eq(scan.id, scanId)))[0];
  if (target && target.sessionId !== sessionId) throw new Error("Scan not found in this session.");
  // No `target` at all means a retried request after a dropped response
  // landed here once the first attempt already undid it — already the
  // desired end state, not an error.
  if (target) await db.delete(scan).where(eq(scan.id, scanId));
  return loadDashboard(sessionId);
}

export type SubmitInput = {
  sessionId: string;
  userId: string;
  awbNumber: string;
  masterUpsTracking: string;
  shipDate: string;
  notes: string;
  boxUpsTracking: Record<string, string>; // boxId -> optional per-box tracking
};

export type SubmitResult =
  | { status: "ok" }
  | { status: "error"; message: string };

export async function submitSession(input: SubmitInput): Promise<SubmitResult> {
  const dashboard = await loadDashboard(input.sessionId);
  if (dashboard.session.status !== "open") {
    return { status: "error", message: "Session is not open." };
  }
  if (dashboard.scans.length === 0) {
    return { status: "error", message: "No scans recorded — nothing to submit." };
  }

  const emptyBoxes = dashboard.boxes.filter((b) => b.scanCount === 0);
  if (emptyBoxes.length > 0) {
    return {
      status: "error",
      message: `Box ${emptyBoxes.map((b) => b.boxNumber).join(", ")} has no scans — remove it or scan into it before submitting.`,
    };
  }

  const hasEpg = dashboard.totals.epg > 0;
  if (hasEpg && !input.awbNumber.trim()) {
    return { status: "error", message: "AWB is required — this shipment has ePost Global parcels." };
  }
  if (hasEpg && !input.masterUpsTracking.trim()) {
    return {
      status: "error",
      message: "Master UPS tracking is required — this shipment has ePost Global parcels.",
    };
  }

  // shipDate is stored as plain text and drives `listShipments`' equality
  // filter and the daily-volume chart's zero-fill lookup, so a malformed value
  // doesn't error — it silently makes the whole day disappear from both.
  const requestedShipDate = input.shipDate.trim();
  if (requestedShipDate && !isCalendarDate(requestedShipDate)) {
    return { status: "error", message: "Ship date must be in YYYY-MM-DD format." };
  }

  // One transaction: previously the per-box tracking writes committed
  // individually before the session update, so a failure partway left boxes
  // stamped with tracking numbers on a still-open shipment.
  const submitted = await db.transaction(async (tx) => {
    for (const [boxId, tracking] of Object.entries(input.boxUpsTracking)) {
      const trackingNumber = tracking.trim() || null;
      // Scoped to this session's boxes, not just `box.id`. boxUpsTracking is
      // a client-supplied map and Server Actions are callable directly, so an
      // unscoped update let any packer write tracking numbers onto boxes
      // belonging to someone else's shipment.
      await tx
        .update(box)
        .set({ upsTracking: trackingNumber })
        .where(and(eq(box.id, boxId), eq(box.sessionId, input.sessionId)));
    }

    const rows = await tx
      .update(shipmentSession)
      .set({
        status: "submitted",
        submittedAt: nowSqlTimestamp(),
        submittedBy: input.userId,
        // A shipment's date of record is the day it was submitted, not the
        // day the session happened to be opened — those can differ (a
        // session opened late one day and submitted after midnight, for
        // instance). `today()` here is "right now, at submit time," not the
        // stale value the session was created with.
        shipDate: requestedShipDate || today(),
        notes: input.notes,
        awbNumber: input.awbNumber.trim() || null,
        masterUpsTracking: input.masterUpsTracking.trim() || null,
      })
      // `status = open` in the WHERE, not just the id: the check at the top of
      // this function reads through a separate query, so two packers pressing
      // Submit together both passed it and both wrote, last-write-wins. Now the
      // second update matches zero rows and is reported as already submitted.
      .where(and(eq(shipmentSession.id, input.sessionId), eq(shipmentSession.status, "open")))
      .returning({ id: shipmentSession.id });

    return rows.length > 0;
  });

  if (!submitted) {
    return { status: "error", message: "This shipment was already submitted." };
  }

  return { status: "ok" };
}

export async function removeEmptyBox(sessionId: string, boxId: string): Promise<SessionDashboard> {
  await assertSessionOpen(sessionId);
  const target = (await db.select().from(box).where(eq(box.id, boxId)))[0];
  if (target && target.sessionId !== sessionId) throw new Error("Box not found in this session.");
  // No `target` at all means a retried request after a dropped response
  // landed here once the first attempt already removed it — already the
  // desired end state, not an error.
  if (target) {
    const countRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(scan)
      .where(eq(scan.boxId, boxId));
    // Number() like every other count in this file — postgres-js returns
    // count(*) as a string, and `"0" > 0` only happens to work via JS numeric
    // coercion. This was the one comparison still relying on that.
    if (Number(countRow[0]?.count ?? 0) > 0) throw new Error("Box has scans — cannot remove.");

    const session = (await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)))[0];
    await db.delete(box).where(eq(box.id, boxId));
    if (session?.activeBoxId === boxId) {
      await db.update(shipmentSession).set({ activeBoxId: null }).where(eq(shipmentSession.id, sessionId));
    }
  }
  return loadDashboard(sessionId);
}

/**
 * Wipes the current open session's scans and boxes and voids it —
 * "start today over." Deleting (not just voiding) the scan rows matters:
 * `scan.tracking_number` is globally unique, so a voided session that kept
 * its rows would permanently block rescanning the same parcels later today.
 * The voided row itself is kept (with a stamp, same pattern as
 * reopenSession) purely as an audit trail that a reset happened;
 * `listShipments` already excludes voided sessions, so it never surfaces in
 * history.
 *
 * Does not open a replacement session — like any other day, the next OPEN
 * row isn't created until the first scan after the reset actually commits
 * (see `createOpenSessionRow`). Returns null for "no open session," same as
 * `getOpenSession`.
 */
export async function resetSession(
  sessionId: string,
  resetByUserId: string,
  resetByUserName: string,
): Promise<{ dashboard: null; restore: RestorableReset }> {
  await db.transaction(async (tx) => {
    const session = (
      await tx.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId))
    )[0];
    if (!session || session.status !== "open") {
      throw new Error("Only the open session can be reset.");
    }

    const scanRows = await tx.select().from(scan).where(eq(scan.sessionId, sessionId));
    const boxRows = await tx.select().from(box).where(eq(box.sessionId, sessionId));
    const scanCount = scanRows.length;
    await tx.insert(shipmentReset).values({
      id: newId(),
      sessionId,
      snapshot: JSON.stringify({ session, boxes: boxRows, scans: scanRows } satisfies ResetSnapshot),
      expiresAt: toSqlTimestamp(new Date(Date.now() + RESET_RESTORE_WINDOW_MS)),
      resetBy: resetByUserId,
    });

    await tx.delete(scan).where(eq(scan.sessionId, sessionId));
    await tx.delete(box).where(eq(box.sessionId, sessionId));

    const stamp = `[Reset by ${resetByUserName} at ${nowSqlTimestamp()} UTC — ${scanCount} scan${scanCount === 1 ? "" : "s"} discarded]`;
    await tx
      .update(shipmentSession)
      .set({
        status: "voided",
        activeBoxId: null,
        notes: session.notes ? `${session.notes}\n${stamp}` : stamp,
      })
      .where(eq(shipmentSession.id, sessionId));
  });

  const latest = (await db.select().from(shipmentReset)
    .where(and(eq(shipmentReset.sessionId, sessionId), isNull(shipmentReset.restoredAt)))
    .orderBy(desc(shipmentReset.resetAt)).limit(1))[0];
  if (!latest) throw new Error("Reset backup could not be created.");
  const snapshot = JSON.parse(latest.snapshot) as ResetSnapshot;
  return { dashboard: null, restore: { id: latest.id, expiresAt: latest.expiresAt, scanCount: snapshot.scans.length } };
}

/** A refresh should not make the 30-minute undo control disappear. */
export async function getRestorableReset(): Promise<RestorableReset | null> {
  const row = (await db.select().from(shipmentReset)
    .where(and(isNull(shipmentReset.restoredAt), gt(shipmentReset.expiresAt, nowSqlTimestamp())))
    .orderBy(desc(shipmentReset.resetAt)).limit(1))[0];
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot) as ResetSnapshot;
  return { id: row.id, expiresAt: row.expiresAt, scanCount: snapshot.scans.length };
}

export async function restoreReset(resetId: string): Promise<SessionDashboard> {
  // loadDashboard reads through the module-level `db`, not this
  // transaction's `tx` — called from inside the transaction (as it
  // originally was), it ran against a separate connection that couldn't
  // see the scans/boxes this same transaction had just inserted but not
  // yet committed. It came back with the session marked open but zero
  // scans, and stayed that way until the *next* unrelated write (e.g. a
  // new scan) forced a fresh load — which is exactly the "nothing shows
  // up until I scan something new" bug. Same fix as resetSession just
  // above: only return the id from inside the transaction, and load the
  // dashboard after it's actually committed.
  const sessionId = await db.transaction(async (tx) => {
    const row = (await tx.select().from(shipmentReset).where(eq(shipmentReset.id, resetId)).limit(1))[0];
    if (!row || row.restoredAt || row.expiresAt <= nowSqlTimestamp()) throw new Error("This reset can no longer be restored.");
    const otherOpen = await tx.select({ id: shipmentSession.id }).from(shipmentSession).where(eq(shipmentSession.status, "open"));
    if (otherOpen.length > 0) throw new Error("A new session has already started, so this reset cannot be restored safely.");

    const snapshot = JSON.parse(row.snapshot) as ResetSnapshot;
    const reserved = await tx.update(shipmentReset).set({ restoredAt: nowSqlTimestamp() })
      .where(and(eq(shipmentReset.id, resetId), isNull(shipmentReset.restoredAt), gt(shipmentReset.expiresAt, nowSqlTimestamp())))
      .returning({ id: shipmentReset.id });
    if (!reserved.length) throw new Error("This reset was already restored or expired.");
    if (snapshot.boxes.length) await tx.insert(box).values(snapshot.boxes);
    if (snapshot.scans.length) await tx.insert(scan).values(snapshot.scans);
    await tx.update(shipmentSession)
      .set({ status: "open", activeBoxId: snapshot.session.activeBoxId, notes: snapshot.session.notes })
      .where(eq(shipmentSession.id, snapshot.session.id));
    return snapshot.session.id;
  });
  return loadDashboard(sessionId);
}

export async function reopenSession(sessionId: string, reopenedByName: string): Promise<void> {
  const session = (await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)))[0];
  if (!session) throw new Error("Shipment not found.");
  // A retried request after a dropped response lands here once the first
  // attempt already went through — the desired end state is already true,
  // so this is success, not "only a submitted session can be reopened."
  if (session.status === "open") return;
  if (session.status !== "submitted") throw new Error("Only a submitted session can be reopened.");

  // Only one session can be "open" at a time — that's what makes "the open
  // session" an unambiguous concept for scanning. Block reopening a second
  // one until whatever's currently open is submitted.
  const otherOpen = await db.select().from(shipmentSession).where(eq(shipmentSession.status, "open"));
  if (otherOpen.length > 0) {
    throw new Error(
      `Cannot reopen — a different shipment (${otherOpen[0].shipDate}) is currently open. Submit it first.`,
    );
  }

  const stamp = `[Reopened by ${reopenedByName} at ${nowSqlTimestamp()} UTC]`;
  try {
    await db
      .update(shipmentSession)
      .set({
        status: "open",
        notes: session.notes ? `${session.notes}\n${stamp}` : stamp,
      })
      .where(eq(shipmentSession.id, sessionId));
  } catch (err) {
    // The "is anything else open?" check above is a separate read, so two
    // reopens racing each other both pass it. A partial unique index on
    // status='open' correctly rejects the loser — but the raw 23505 used to
    // surface to the packer as an unreadable Postgres error.
    if (!isUniqueViolation(err)) throw err;
    throw new Error("Another shipment was opened at the same time — refresh and try again.");
  }
}

/**
 * Soft-deletes a shipment day from history — admin-only, and unlike
 * `resetSession` (which voids the *open* session so scanning can restart)
 * this only ever applies to a submitted or already-voided one. The row (and
 * its scans/boxes) stay in place, just stamped with `deletedAt` and filtered
 * out of `listShipments` — see `restoreShipment` to undo this, and
 * `purgeExpiredTrash` for the 30-day hard-delete that eventually follows.
 */
export async function trashShipment(sessionId: string): Promise<void> {
  const session = (await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)))[0];
  // A retried request after a dropped response lands here once the first
  // attempt already trashed it — that's the desired end state, not an error.
  if (!session) return;
  if (session.status === "open") {
    throw new Error("Cannot delete the open session — use Reset Day instead.");
  }
  if (session.deletedAt) return;
  await db
    .update(shipmentSession)
    .set({ deletedAt: nowSqlTimestamp() })
    .where(eq(shipmentSession.id, sessionId));
}

/** Un-trashes a shipment — admin-only, from the Trash page. */
export async function restoreShipment(sessionId: string): Promise<void> {
  await db.update(shipmentSession).set({ deletedAt: null }).where(eq(shipmentSession.id, sessionId));
}

export type TrashedShipmentItem = ShipmentListItem & { deletedAt: string; daysUntilPurge: number };

// Kept in sync by eye with purgeExpiredTrash's own default — the cron is
// what actually enforces the cutoff, this is only the Trash page's display
// countdown.
const TRASH_RETENTION_DAYS = 30;

/** Everything currently in the trash, most recently deleted first — the
 * Trash page's admin restore view. */
export async function listTrashedShipments(): Promise<TrashedShipmentItem[]> {
  const sessions = await db
    .select()
    .from(shipmentSession)
    .where(isNotNull(shipmentSession.deletedAt))
    .orderBy(desc(shipmentSession.deletedAt));

  // Computed once, here, rather than from Date.now() in the client
  // component that renders this list — React's purity rules don't allow an
  // impure "current time" read during render, and a data-fetching function
  // like this one isn't a render function, so it's the right place for it.
  const now = Date.now();

  const results: TrashedShipmentItem[] = [];
  for (const s of sessions) {
    const scanRows = await db.select().from(scan).where(eq(scan.sessionId, s.id));
    const boxRows = await db.select().from(box).where(eq(box.sessionId, s.id));
    const totals = { epg: 0, ups: 0, dhl: 0, unknown: 0, total: scanRows.length };
    for (const row of scanRows) totals[row.carrier as Carrier] += 1;
    // Non-null by construction — the WHERE clause above only selects rows
    // that have one.
    const deletedAt = s.deletedAt!;
    const daysSinceDeleted = Math.floor((now - parseDbTimestamp(deletedAt).getTime()) / (24 * 60 * 60 * 1000));
    results.push({
      id: s.id,
      shipDate: s.shipDate,
      status: s.status,
      openedAt: s.openedAt,
      submittedAt: s.submittedAt,
      // Not shown on the Trash page (TrashClient only displays shipDate),
      // so a real lookup isn't worth it here — null satisfies the shared
      // ShipmentListItem shape without pretending to know the submitter.
      submittedByCode: null,
      awbNumber: s.awbNumber,
      masterUpsTracking: s.masterUpsTracking,
      masterUpsStatusLabel: s.masterUpsStatusLabel,
      masterUpsStatusAt: s.masterUpsStatusAt,
      totals,
      boxCount: boxRows.length,
      deletedAt,
      daysUntilPurge: Math.max(0, TRASH_RETENTION_DAYS - daysSinceDeleted),
    });
  }
  return results;
}

/**
 * Permanently removes everything trashed more than `retentionDays` ago —
 * the daily purge cron's entry point (see app/api/cron/purge-trash). Same
 * hard-delete order the old unconditional deleteShipment used to use:
 * children first, since `scan`/`box` have no ON DELETE CASCADE.
 */
export async function purgeExpiredTrash(retentionDays = TRASH_RETENTION_DAYS): Promise<{ purgedCount: number }> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000));
  const expired = await db
    .select({ id: shipmentSession.id })
    .from(shipmentSession)
    .where(and(isNotNull(shipmentSession.deletedAt), lt(shipmentSession.deletedAt, cutoff)));

  for (const { id } of expired) {
    await db.transaction(async (tx) => {
      await tx.delete(scan).where(eq(scan.sessionId, id));
      await tx.delete(box).where(eq(box.sessionId, id));
      await tx.delete(shipmentSession).where(eq(shipmentSession.id, id));
    });
  }
  return { purgedCount: expired.length };
}

export type ShipmentListItem = {
  id: string;
  shipDate: string;
  status: string;
  openedAt: string;
  submittedAt: string | null;
  submittedByCode: string | null;
  awbNumber: string | null;
  masterUpsTracking: string | null;
  masterUpsStatusLabel: string | null;
  masterUpsStatusAt: string | null;
  totals: { epg: number; ups: number; dhl: number; unknown: number; total: number };
  boxCount: number;
};

export type ListShipmentsOptions = {
  /** Free-text search against scanned tracking numbers. */
  search?: string;
  /** Exact `ship_date` match ("YYYY-MM-DD") — e.g. "show me everything that went out on the 24th." */
  date?: string;
};

export async function listShipments(opts?: ListShipmentsOptions): Promise<ShipmentListItem[]> {
  let sessionIds: string[] | null = null;

  const term = opts?.search?.trim();
  if (term) {
    const normalized = term.toUpperCase().replace(/\s+/g, "");
    const matches = await db
      .select({ sessionId: scan.sessionId })
      .from(scan)
      .where(sql`upper(${scan.trackingNumber}) LIKE ${"%" + escapeLikePattern(normalized) + "%"}`);
    sessionIds = [...new Set(matches.map((m) => m.sessionId))];
    if (sessionIds.length === 0) return [];
  }

  const date = opts?.date?.trim();

  const sessions = await db
    .select()
    .from(shipmentSession)
    .where(
      and(
        ne(shipmentSession.status, "voided"),
        isNull(shipmentSession.deletedAt),
        sessionIds ? inArray(shipmentSession.id, sessionIds) : undefined,
        date ? eq(shipmentSession.shipDate, date) : undefined,
      ),
    )
    .orderBy(desc(shipmentSession.shipDate), desc(shipmentSession.openedAt));

  // Batched once for the whole page rather than per-row — same submitter
  // shows up across many rows, and this is a small, bounded lookup (one
  // row per distinct submitter, not per shipment).
  const submitterIds = [...new Set(sessions.map((s) => s.submittedBy).filter((id): id is string => id !== null))];
  const submitterCodes: Record<string, string> = {};
  if (submitterIds.length > 0) {
    const submitters = await db.select().from(appUser).where(inArray(appUser.id, submitterIds));
    for (const u of submitters) if (u.packerCode) submitterCodes[u.id] = u.packerCode;
  }

  const results: ShipmentListItem[] = [];
  for (const s of sessions) {
    const scanRows = await db.select().from(scan).where(eq(scan.sessionId, s.id));
    const boxRows = await db.select().from(box).where(eq(box.sessionId, s.id));
    const totals = { epg: 0, ups: 0, dhl: 0, unknown: 0, total: scanRows.length };
    for (const row of scanRows) totals[row.carrier as Carrier] += 1;
    results.push({
      id: s.id,
      shipDate: s.shipDate,
      status: s.status,
      openedAt: s.openedAt,
      submittedAt: s.submittedAt,
      submittedByCode: s.submittedBy ? (submitterCodes[s.submittedBy] ?? null) : null,
      awbNumber: s.awbNumber,
      masterUpsTracking: s.masterUpsTracking,
      masterUpsStatusLabel: s.masterUpsStatusLabel,
      masterUpsStatusAt: s.masterUpsStatusAt,
      totals,
      boxCount: boxRows.length,
    });
  }
  return results;
}

export type ShipmentPaletteHit = {
  id: string;
  shipDate: string;
  status: string;
  awbNumber: string | null;
  totals: { epg: number; ups: number; dhl: number; unknown: number; total: number };
};

/**
 * Lightweight jump-to-shipment lookup for the command palette (§ command
 * palette) — matches session id, AWB, master UPS tracking, ship date, or a
 * scanned tracking number (same tracking-number match `listShipments` uses).
 * Capped and unpaginated since it's a fast-jump, not the full history browser.
 */
export async function searchShipmentsForPalette(query: string, limit = 8): Promise<ShipmentPaletteHit[]> {
  const term = query.trim();
  if (term.length < 2) return [];
  // Escape LIKE metacharacters. Drizzle parameterizes the value so there's no
  // injection risk, but an unescaped `%` or `_` in a searched AWB or tracking
  // number is still treated as a wildcard, silently widening the match.
  const like = `%${escapeLikePattern(term)}%`;

  const normalizedTracking = term.toUpperCase().replace(/\s+/g, "");
  const trackingMatches = await db
    .select({ sessionId: scan.sessionId })
    .from(scan)
    .where(sql`upper(${scan.trackingNumber}) LIKE ${"%" + escapeLikePattern(normalizedTracking) + "%"}`);
  const trackingSessionIds = [...new Set(trackingMatches.map((m) => m.sessionId))];

  const sessions = await db
    .select()
    .from(shipmentSession)
    .where(
      and(
        ne(shipmentSession.status, "voided"),
        isNull(shipmentSession.deletedAt),
        or(
          ilike(shipmentSession.id, like),
          ilike(shipmentSession.awbNumber, like),
          ilike(shipmentSession.masterUpsTracking, like),
          ilike(shipmentSession.shipDate, like),
          trackingSessionIds.length > 0 ? inArray(shipmentSession.id, trackingSessionIds) : undefined,
        ),
      ),
    )
    .orderBy(desc(shipmentSession.shipDate), desc(shipmentSession.openedAt))
    .limit(limit);

  const results: ShipmentPaletteHit[] = [];
  for (const s of sessions) {
    const scanRows = await db.select({ carrier: scan.carrier }).from(scan).where(eq(scan.sessionId, s.id));
    const totals = { epg: 0, ups: 0, dhl: 0, unknown: 0, total: scanRows.length };
    for (const row of scanRows) totals[row.carrier as Carrier] += 1;
    results.push({ id: s.id, shipDate: s.shipDate, status: s.status, awbNumber: s.awbNumber, totals });
  }
  return results;
}

export async function getShipmentDetail(sessionId: string): Promise<SessionDashboard> {
  return loadDashboard(sessionId);
}

export type DailyVolumePoint = {
  shipDate: string;
  epg: number;
  ups: number;
  dhl: number;
  unknown: number;
  total: number;
};

/**
 * Daily package volume for the shipments-page chart — one point per
 * calendar day in the trailing window, zero-filled for days with nothing
 * submitted (so gaps in the shipping cadence are visible, not skipped).
 * Only counts `submitted` sessions: "packages sent out" means shipped, not
 * still sitting in an open/draft session.
 */
export async function getDailyVolume(days: number = 30): Promise<DailyVolumePoint[]> {
  const cutoff = localCalendarDate(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));

  const rows = await db
    .select({
      shipDate: shipmentSession.shipDate,
      carrier: scan.carrier,
      count: sql<number>`count(*)`,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(and(eq(shipmentSession.status, "submitted"), sql`${shipmentSession.shipDate} >= ${cutoff}`))
    .groupBy(shipmentSession.shipDate, scan.carrier);

  const byDate = new Map<string, DailyVolumePoint>();
  for (const r of rows) {
    const point = byDate.get(r.shipDate) ?? {
      shipDate: r.shipDate,
      epg: 0,
      ups: 0,
      dhl: 0,
      unknown: 0,
      total: 0,
    };
    // postgres-js returns count(*) as a string — Number() it before summing.
    const count = Number(r.count);
    point[r.carrier as Carrier] += count;
    point.total += count;
    byDate.set(r.shipDate, point);
  }

  const points: DailyVolumePoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = localCalendarDate(new Date(Date.now() - (days - 1 - i) * 24 * 60 * 60 * 1000));
    points.push(byDate.get(d) ?? { shipDate: d, epg: 0, ups: 0, dhl: 0, unknown: 0, total: 0 });
  }
  return points;
}
