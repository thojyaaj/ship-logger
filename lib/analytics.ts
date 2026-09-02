import "server-only";
import { db } from "./db";
import { appUser, shipmentSession, box, scan, shipmentReset, dhlPickupRequest } from "./db/schema";
import { and, eq, sql, ne, isNull, isNotNull, inArray, desc } from "drizzle-orm";
import { localCalendarDate, toSqlTimestamp, parseDbTimestamp, warehouseLocalTime } from "./date";
import type { Carrier } from "./carrier";

/**
 * Every query on this page windows on a trailing N-day range, computed the
 * same two ways used elsewhere in the app: a calendar-day cutoff
 * (shipDate, a plain "YYYY-MM-DD") for anything keyed off which day a
 * shipment went out, and a full timestamp cutoff (scannedAt/requestedAt/
 * resetAt/deletedAt) for anything keyed off when an event actually
 * happened. Both are derived from the same `days` so every card on the
 * page reflects the same window.
 */
function calendarCutoff(days: number): string {
  return localCalendarDate(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
}
function timestampCutoff(days: number): string {
  return toSqlTimestamp(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

/** Shared by every "packages actually shipped" query — a submitted, non-trashed session within the window. */
function submittedInWindow(days: number) {
  return and(eq(shipmentSession.status, "submitted"), isNull(shipmentSession.deletedAt), sql`${shipmentSession.shipDate} >= ${calendarCutoff(days)}`);
}

export type OverviewStats = {
  shipmentsSubmitted: number;
  totalPackages: number;
  totalBoxes: number;
  avgPackagesPerShipment: number;
  avgBoxesPerShipment: number;
  /** Wall-clock time from open to submit, averaged across submitted sessions in the window — how long a shipment day takes to pack out, start to close. */
  avgHoursToSubmit: number | null;
};

export async function getOverviewStats(days: number): Promise<OverviewStats> {
  const sessions = await db
    .select({ id: shipmentSession.id, openedAt: shipmentSession.openedAt, submittedAt: shipmentSession.submittedAt })
    .from(shipmentSession)
    .where(submittedInWindow(days));

  const sessionIds = sessions.map((s) => s.id);
  let totalPackages = 0;
  let totalBoxes = 0;
  if (sessionIds.length > 0) {
    const [scanCountRow] = await db.select({ count: sql<number>`count(*)` }).from(scan).where(inArray(scan.sessionId, sessionIds));
    const [boxCountRow] = await db.select({ count: sql<number>`count(*)` }).from(box).where(inArray(box.sessionId, sessionIds));
    totalPackages = Number(scanCountRow?.count ?? 0);
    totalBoxes = Number(boxCountRow?.count ?? 0);
  }

  const durationsHours: number[] = [];
  for (const s of sessions) {
    if (!s.submittedAt) continue;
    const hours = (parseDbTimestamp(s.submittedAt).getTime() - parseDbTimestamp(s.openedAt).getTime()) / (1000 * 60 * 60);
    if (hours > 0) durationsHours.push(hours);
  }

  return {
    shipmentsSubmitted: sessions.length,
    totalPackages,
    totalBoxes,
    avgPackagesPerShipment: sessions.length > 0 ? totalPackages / sessions.length : 0,
    avgBoxesPerShipment: sessions.length > 0 ? totalBoxes / sessions.length : 0,
    avgHoursToSubmit: durationsHours.length > 0 ? durationsHours.reduce((a, b) => a + b, 0) / durationsHours.length : null,
  };
}

export type CarrierMixPoint = { carrier: Carrier; count: number; pct: number };

const CARRIER_ORDER: Carrier[] = ["epg", "ups", "dhl", "unknown"];

/** Package volume split by carrier over the window — what share of everything shipped went out EPG vs UPS vs DHL. */
export async function getCarrierMix(days: number): Promise<CarrierMixPoint[]> {
  const rows = await db
    .select({ carrier: scan.carrier, count: sql<number>`count(*)` })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(submittedInWindow(days))
    .groupBy(scan.carrier);

  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return CARRIER_ORDER.map((carrier) => {
    const count = Number(rows.find((r) => r.carrier === carrier)?.count ?? 0);
    return { carrier, count, pct: total > 0 ? (count / total) * 100 : 0 };
  });
}

export type PackerStat = {
  userId: string;
  name: string;
  packerCode: string | null;
  scans: number;
  shipmentsSubmitted: number;
};

/** Per-packer activity — scan volume (who's actually working the belt) and shipments closed out (who's submitting), by user. */
export async function getPackerLeaderboard(days: number): Promise<PackerStat[]> {
  const scanRows = await db
    .select({ scannedBy: scan.scannedBy, count: sql<number>`count(*)` })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(and(isNull(shipmentSession.deletedAt), ne(shipmentSession.status, "voided"), sql`${scan.scannedAt} >= ${timestampCutoff(days)}`))
    .groupBy(scan.scannedBy);

  const submitRows = await db
    .select({ submittedBy: shipmentSession.submittedBy, count: sql<number>`count(*)` })
    .from(shipmentSession)
    .where(and(submittedInWindow(days), isNotNull(shipmentSession.submittedBy)))
    .groupBy(shipmentSession.submittedBy);

  const userIds = new Set<string>();
  for (const r of scanRows) userIds.add(r.scannedBy);
  for (const r of submitRows) if (r.submittedBy) userIds.add(r.submittedBy);
  if (userIds.size === 0) return [];

  const users = await db.select().from(appUser).where(inArray(appUser.id, [...userIds]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const scansByUser = new Map(scanRows.map((r) => [r.scannedBy, Number(r.count)]));
  const submitsByUser = new Map(submitRows.filter((r) => r.submittedBy).map((r) => [r.submittedBy as string, Number(r.count)]));

  return [...userIds]
    .map((id) => {
      const u = userById.get(id);
      return {
        userId: id,
        name: u?.name ?? "Unknown",
        packerCode: u?.packerCode ?? null,
        scans: scansByUser.get(id) ?? 0,
        shipmentsSubmitted: submitsByUser.get(id) ?? 0,
      };
    })
    .sort((a, b) => b.scans - a.scans);
}

export type HourlyActivityPoint = { hour: number; count: number };

/**
 * Scan counts bucketed by warehouse-local hour of day (0-23), summed across
 * the whole window — when packers are actually scanning, not just how much
 * they scan. Bucketed in JS (not SQL) via warehouseLocalTime, same as every
 * other warehouse-local-time computation in this app (see lib/date.ts) —
 * Vercel's Node runtime has no TZ set, so a SQL-side `AT TIME ZONE` would
 * need the same America/Chicago constant duplicated into the query.
 */
export async function getHourlyActivity(days: number): Promise<HourlyActivityPoint[]> {
  const rows = await db
    .select({ scannedAt: scan.scannedAt })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(and(isNull(shipmentSession.deletedAt), ne(shipmentSession.status, "voided"), sql`${scan.scannedAt} >= ${timestampCutoff(days)}`));

  const counts = new Array(24).fill(0) as number[];
  for (const r of rows) {
    const hour = Number(warehouseLocalTime(r.scannedAt).slice(0, 2));
    counts[hour] += 1;
  }
  return counts.map((count, hour) => ({ hour, count }));
}

export type OrderMatchStat = { carrier: Carrier; matched: number; total: number; pct: number };

/**
 * What share of scans resolved to a real Shopify order at scan time, by
 * carrier — EPG resolves via its ERef, UPS/DHL via the Shopify order index
 * (see lib/order-index.ts). A dropping match rate is an early warning that
 * webhook backfill or ERef coalescing has quietly broken.
 */
export async function getOrderMatchRate(days: number): Promise<OrderMatchStat[]> {
  const rows = await db
    .select({
      carrier: scan.carrier,
      matched: sql<number>`count(*) filter (where ${scan.orderGid} is not null)`,
      total: sql<number>`count(*)`,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(submittedInWindow(days))
    .groupBy(scan.carrier);

  return rows
    .map((r) => {
      const total = Number(r.total);
      const matched = Number(r.matched);
      return { carrier: r.carrier as Carrier, matched, total, pct: total > 0 ? (matched / total) * 100 : 0 };
    })
    .sort((a, b) => b.total - a.total);
}

export type StatusBreakdownPoint = { label: string; count: number };

/** Top current carrier-status labels across submitted shipments in the window — a live read of "where is everything" (delivered vs in-transit vs exception) without opening every shipment. */
export async function getStatusBreakdown(days: number): Promise<StatusBreakdownPoint[]> {
  const rows = await db
    .select({ label: scan.statusLabel, count: sql<number>`count(*)` })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(and(submittedInWindow(days), isNotNull(scan.statusLabel)))
    .groupBy(scan.statusLabel)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  return rows.map((r) => ({ label: r.label ?? "Unknown", count: Number(r.count) }));
}

export type DhlPickupStats = {
  requested: number;
  cancelled: number;
  failed: number;
  totalParcels: number;
  totalWeightLb: number;
  avgWeightLb: number | null;
};

/**
 * DHL pickup booking activity in the window. "requested" and "cancelled"
 * both represent a pickup DHL actually accepted at some point (cancelling
 * updates the same row's status rather than leaving it "requested" — see
 * DhlPickupPanel's confirmCancel), so both count toward parcels/weight;
 * "failed" never booked anything and is excluded from those totals.
 */
export async function getDhlPickupStats(days: number): Promise<DhlPickupStats> {
  const rows = await db
    .select()
    .from(dhlPickupRequest)
    .where(sql`${dhlPickupRequest.requestedAt} >= ${timestampCutoff(days)}`);

  const stats: DhlPickupStats = { requested: 0, cancelled: 0, failed: 0, totalParcels: 0, totalWeightLb: 0, avgWeightLb: null };
  let bookedCount = 0;
  for (const r of rows) {
    if (r.status === "requested") stats.requested += 1;
    else if (r.status === "cancelled") stats.cancelled += 1;
    else stats.failed += 1;

    if (r.status !== "failed") {
      stats.totalParcels += r.parcelCount;
      stats.totalWeightLb += r.totalWeightLb;
      bookedCount += 1;
    }
  }
  stats.totalWeightLb = Math.round(stats.totalWeightLb * 10) / 10;
  stats.avgWeightLb = bookedCount > 0 ? Math.round((stats.totalWeightLb / bookedCount) * 10) / 10 : null;
  return stats;
}

export type OperationalHealth = {
  reopenedShipments: number;
  resets: number;
  restoredResets: number;
  trashedShipments: number;
};

/**
 * Data-quality/exception signals rather than volume — how often a shipment
 * needed correction after submit, how often Reset Day got used (and
 * whether it was a genuine restore afterward), and how many shipments got
 * trashed. None of these are inherently bad in isolation, but a rising
 * trend is worth a packer conversation.
 */
export async function getOperationalHealth(days: number): Promise<OperationalHealth> {
  // reopenSession stamps `[Reopened by <name> at <ts> UTC]` into notes (see
  // lib/shiplog.ts) rather than a structured column — this counts sessions
  // with at least one such stamp, not the exact number of reopens on a
  // shipment reopened more than once, which is enough for a trend signal.
  const [reopenedRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipmentSession)
    .where(and(sql`${shipmentSession.notes} LIKE '%[Reopened by%'`, sql`${shipmentSession.shipDate} >= ${calendarCutoff(days)}`));

  const resetRows = await db
    .select({ restoredAt: shipmentReset.restoredAt })
    .from(shipmentReset)
    .where(sql`${shipmentReset.resetAt} >= ${timestampCutoff(days)}`);

  const [trashedRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipmentSession)
    .where(and(isNotNull(shipmentSession.deletedAt), sql`${shipmentSession.deletedAt} >= ${timestampCutoff(days)}`));

  return {
    reopenedShipments: Number(reopenedRow?.count ?? 0),
    resets: resetRows.length,
    restoredResets: resetRows.filter((r) => r.restoredAt !== null).length,
    trashedShipments: Number(trashedRow?.count ?? 0),
  };
}

export type WeekdayVolumePoint = { weekday: number; label: string; count: number };

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Package volume summed by day of week across the whole window — which day of the week actually ships the most, independent of any one calendar date. */
export async function getWeekdayVolume(days: number): Promise<WeekdayVolumePoint[]> {
  const rows = await db
    .select({ shipDate: shipmentSession.shipDate, count: sql<number>`count(*)` })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(submittedInWindow(days))
    .groupBy(shipmentSession.shipDate);

  const counts = new Array(7).fill(0) as number[];
  for (const r of rows) {
    // shipDate is a plain "YYYY-MM-DD" calendar day, not an instant — parsed
    // as UTC midnight purely to ask "which weekday is this", never rendered
    // or compared as a real timestamp, so there's no timezone to get wrong.
    const [y, m, d] = r.shipDate.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    counts[weekday] += Number(r.count);
  }
  return counts.map((count, weekday) => ({ weekday, label: WEEKDAY_LABELS[weekday], count }));
}

export type PeriodMetric = { current: number; previous: number; pctChange: number | null };
export type PeriodComparison = { shipments: PeriodMetric; packages: PeriodMetric };

function pctChange(current: number, previous: number): number | null {
  // 0-in-both reads as "no change" (0%); 0-to-something has no previous
  // baseline to divide by, so it's left null rather than shown as a
  // nonsensical "+∞%" or silently clamped to some arbitrary number.
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/**
 * The current window vs the equal-length window immediately before it —
 * e.g. the trailing 30 days vs the 30 days before that — so the overview
 * KPIs can show "up 12%" instead of a bare count with no baseline to judge
 * it against.
 */
export async function getPeriodComparison(days: number): Promise<PeriodComparison> {
  const currentFrom = calendarCutoff(days);
  const previousFrom = localCalendarDate(new Date(Date.now() - (2 * days - 1) * 24 * 60 * 60 * 1000));

  const sessions = await db
    .select({ id: shipmentSession.id, shipDate: shipmentSession.shipDate })
    .from(shipmentSession)
    .where(and(eq(shipmentSession.status, "submitted"), isNull(shipmentSession.deletedAt), sql`${shipmentSession.shipDate} >= ${previousFrom}`));

  const currentSessions = sessions.filter((s) => s.shipDate >= currentFrom);
  const previousSessions = sessions.filter((s) => s.shipDate < currentFrom);

  async function packageCount(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(scan).where(inArray(scan.sessionId, sessionIds));
    return Number(row?.count ?? 0);
  }

  const [currentPackages, previousPackages] = await Promise.all([
    packageCount(currentSessions.map((s) => s.id)),
    packageCount(previousSessions.map((s) => s.id)),
  ]);

  return {
    shipments: {
      current: currentSessions.length,
      previous: previousSessions.length,
      pctChange: pctChange(currentSessions.length, previousSessions.length),
    },
    packages: { current: currentPackages, previous: previousPackages, pctChange: pctChange(currentPackages, previousPackages) },
  };
}
