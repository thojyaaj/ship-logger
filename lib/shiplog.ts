import "server-only";
import { db } from "./db";
import { appUser, shipmentSession, box, scan } from "./db/schema";
import { and, eq, desc, sql, ne, inArray, ilike, or } from "drizzle-orm";
import { newId } from "./id";
import { detectCarrier, type Carrier } from "./carrier";
import { nowSqlTimestamp, localCalendarDate } from "./date";
import { lookupOrderIndex } from "./order-index";

function today(): string {
  return localCalendarDate();
}

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
};

async function loadDashboard(sessionId: string): Promise<SessionDashboard> {
  const sessionRows = await db
    .select()
    .from(shipmentSession)
    .where(eq(shipmentSession.id, sessionId))
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new Error("Session not found.");

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

  const userIds = [...new Set(scans.map((s) => s.scannedBy))];
  const userNames: Record<string, string> = {};
  if (userIds.length > 0) {
    const users = await db.select().from(appUser).where(inArray(appUser.id, userIds));
    for (const u of users) userNames[u.id] = u.name;
  }

  return { session, boxes, scans, totals, userNames };
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === POSTGRES_UNIQUE_VIOLATION;
}

/**
 * Two packers loading the scan page at the same moment (or a Reset Day
 * racing a second tab's load) could both see zero open sessions and both
 * try to create one. The partial unique index on `status = 'open'`
 * (migration 0003) makes the database reject the loser's INSERT instead of
 * silently creating two open sessions — that loser then just re-reads and
 * returns whichever session actually won, same as if it had seen it up
 * front.
 */
export async function getOrCreateOpenSession(userId: string): Promise<SessionDashboard> {
  const openRows = await db
    .select()
    .from(shipmentSession)
    .where(eq(shipmentSession.status, "open"))
    .orderBy(desc(shipmentSession.openedAt))
    .limit(1);

  if (openRows[0]) {
    return loadDashboard(openRows[0].id);
  }

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
    return loadDashboard(winner[0].id);
  }
  return loadDashboard(id);
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
  sessionId: string;
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
    await db.delete(scan).where(eq(scan.id, existing.id));
  }

  const session = (
    await db.select().from(shipmentSession).where(eq(shipmentSession.id, input.sessionId))
  )[0];
  if (!session || session.status !== "open") throw new Error("Session is not open.");

  let boxId: string | null = null;
  let boxNumber: number | null = null;
  if (finalCarrier === "epg") {
    let activeBox = session.activeBoxId
      ? (await db.select().from(box).where(eq(box.id, session.activeBoxId)))[0]
      : undefined;
    if (!activeBox) {
      const existingBoxes = await db.select().from(box).where(eq(box.sessionId, input.sessionId));
      const nextNumber = existingBoxes.reduce((max, b) => Math.max(max, b.boxNumber), 0) + 1;
      const id = newId();
      await db.insert(box).values({ id, sessionId: input.sessionId, boxNumber: nextNumber });
      await db
        .update(shipmentSession)
        .set({ activeBoxId: id })
        .where(eq(shipmentSession.id, input.sessionId));
      activeBox = { id, sessionId: input.sessionId, boxNumber: nextNumber, upsTracking: null };
    }
    boxId = activeBox.id;
    boxNumber = activeBox.boxNumber;
  }

  const countRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(scan)
    .where(eq(scan.sessionId, input.sessionId));
  // postgres-js returns count(*) as a string (bigint-safe) — Number() it
  // before arithmetic, or string concatenation silently misbehaves.
  const sequence = Number(countRow[0]?.count ?? 0) + 1;

  // §9c: UPS/DHL enrichment is a local, no-network lookup against the
  // webhook-fed index (§9b) — never a live Shopify call at scan time. EPG
  // enrichment instead happens later, in the EPG status cron (§9a), since
  // it depends on `epg_external_ref` which isn't known until EPG ingests
  // the label.
  const orderMatch =
    finalCarrier === "ups" || finalCarrier === "dhl"
      ? await lookupOrderIndex(trackingNumber)
      : null;

  await db.insert(scan).values({
    id: newId(),
    sessionId: input.sessionId,
    boxId,
    scannedBy: input.userId,
    trackingNumber,
    carrier: finalCarrier,
    sequence,
    orderGid: orderMatch?.orderGid,
    orderName: orderMatch?.orderName,
  });

  const dashboard = await loadDashboard(input.sessionId);
  return { status: "ok", dashboard, carrier: finalCarrier, boxNumber };
}

export async function undoScan(sessionId: string, scanId: string): Promise<SessionDashboard> {
  const target = (await db.select().from(scan).where(eq(scan.id, scanId)))[0];
  if (!target || target.sessionId !== sessionId) throw new Error("Scan not found in this session.");
  await db.delete(scan).where(eq(scan.id, scanId));
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

  for (const [boxId, tracking] of Object.entries(input.boxUpsTracking)) {
    if (tracking.trim()) {
      await db.update(box).set({ upsTracking: tracking.trim() }).where(eq(box.id, boxId));
    }
  }

  await db
    .update(shipmentSession)
    .set({
      status: "submitted",
      submittedAt: nowSqlTimestamp(),
      submittedBy: input.userId,
      shipDate: input.shipDate || dashboard.session.shipDate,
      notes: input.notes,
      awbNumber: input.awbNumber.trim() || null,
      masterUpsTracking: input.masterUpsTracking.trim() || null,
    })
    .where(eq(shipmentSession.id, input.sessionId));

  return { status: "ok" };
}

export async function removeEmptyBox(sessionId: string, boxId: string): Promise<SessionDashboard> {
  const target = (await db.select().from(box).where(eq(box.id, boxId)))[0];
  if (!target || target.sessionId !== sessionId) throw new Error("Box not found in this session.");
  const countRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(scan)
    .where(eq(scan.boxId, boxId));
  if ((countRow[0]?.count ?? 0) > 0) throw new Error("Box has scans — cannot remove.");

  const session = (await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)))[0];
  await db.delete(box).where(eq(box.id, boxId));
  if (session?.activeBoxId === boxId) {
    await db.update(shipmentSession).set({ activeBoxId: null }).where(eq(shipmentSession.id, sessionId));
  }
  return loadDashboard(sessionId);
}

/**
 * Wipes the current open session's scans and boxes and voids it, then opens
 * a fresh one — "start today over." Deleting (not just voiding) the scan
 * rows matters: `scan.tracking_number` is globally unique, so a voided
 * session that kept its rows would permanently block rescanning the same
 * parcels later today. The voided row itself is kept (with a stamp, same
 * pattern as reopenSession) purely as an audit trail that a reset happened;
 * `listShipments` already excludes voided sessions, so it never surfaces in
 * history.
 */
export async function resetSession(
  sessionId: string,
  resetByUserId: string,
  resetByUserName: string,
): Promise<SessionDashboard> {
  await db.transaction(async (tx) => {
    const session = (
      await tx.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId))
    )[0];
    if (!session || session.status !== "open") {
      throw new Error("Only the open session can be reset.");
    }

    const countRow = await tx
      .select({ count: sql<number>`count(*)` })
      .from(scan)
      .where(eq(scan.sessionId, sessionId));
    // postgres-js returns count(*) as a string (bigint-safe) — Number() it
    // before comparing/interpolating, or `=== 1` and string concatenation
    // both silently misbehave.
    const scanCount = Number(countRow[0]?.count ?? 0);

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

  return getOrCreateOpenSession(resetByUserId);
}

export async function reopenSession(sessionId: string, reopenedByName: string): Promise<void> {
  const session = (await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)))[0];
  if (!session || session.status !== "submitted") throw new Error("Only a submitted session can be reopened.");

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
  await db
    .update(shipmentSession)
    .set({
      status: "open",
      notes: session.notes ? `${session.notes}\n${stamp}` : stamp,
    })
    .where(eq(shipmentSession.id, sessionId));
}

/**
 * Permanently removes a shipment day from history — admin-only, and unlike
 * `resetSession` (which voids the *open* session so scanning can restart)
 * this hard-deletes a submitted or already-voided one, no trace left in
 * `listShipments`. FK columns on `scan`/`box` have no ON DELETE CASCADE, so
 * children are deleted first in the same order `resetSession` already uses.
 */
export async function deleteShipment(sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const session = (
      await tx.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId))
    )[0];
    if (!session) throw new Error("Shipment not found.");
    if (session.status === "open") {
      throw new Error("Cannot delete the open session — use Reset Day instead.");
    }

    await tx.delete(scan).where(eq(scan.sessionId, sessionId));
    await tx.delete(box).where(eq(box.sessionId, sessionId));
    await tx.delete(shipmentSession).where(eq(shipmentSession.id, sessionId));
  });
}

export type ShipmentListItem = {
  id: string;
  shipDate: string;
  status: string;
  openedAt: string;
  submittedAt: string | null;
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
      .where(sql`upper(${scan.trackingNumber}) LIKE ${"%" + normalized + "%"}`);
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
        sessionIds ? inArray(shipmentSession.id, sessionIds) : undefined,
        date ? eq(shipmentSession.shipDate, date) : undefined,
      ),
    )
    .orderBy(desc(shipmentSession.shipDate), desc(shipmentSession.openedAt));

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
  const like = `%${term}%`;

  const normalizedTracking = term.toUpperCase().replace(/\s+/g, "");
  const trackingMatches = await db
    .select({ sessionId: scan.sessionId })
    .from(scan)
    .where(sql`upper(${scan.trackingNumber}) LIKE ${"%" + normalizedTracking + "%"}`);
  const trackingSessionIds = [...new Set(trackingMatches.map((m) => m.sessionId))];

  const sessions = await db
    .select()
    .from(shipmentSession)
    .where(
      and(
        ne(shipmentSession.status, "voided"),
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
