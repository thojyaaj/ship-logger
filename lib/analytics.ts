import "server-only";
import { db } from "./db";
import { appUser, shipmentSession, box, scan, shipmentReset, dhlPickupRequest } from "./db/schema";
import { and, eq, sql, ne, or, desc, isNull, isNotNull, inArray } from "drizzle-orm";
import { localCalendarDate, toSqlTimestamp, parseDbTimestamp, parseCarrierTimestamp, warehouseLocalTime } from "./date";
import { EXCEPTION_STATUS_RE, categorizeException, type Carrier, type ExceptionCategory } from "./carrier";
import { getDhlPickupSettings } from "./dhl-pickup";
import {
  buildMarginTrend,
  buildWeekdayVolume,
  diagnoseOnTime,
  diagnoseRateShop,
  type CarrierMarginTrend,
  type MarginDayRow,
  type PipelineCounts,
  type PipelineDiagnosis,
  type WeekdayCarrierPoint,
} from "./analytics-derive";

/** Shared money-rounding — every $ figure in this file is rounded to cents once, at the point it's returned, not on every intermediate add. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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
  /** EPG-only — the one carrier we consolidate into boxes (see totalBoxes). */
  totalEpgPackages: number;
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
  let totalEpgPackages = 0;
  let totalBoxes = 0;
  if (sessionIds.length > 0) {
    const [scanCountRow] = await db.select({ count: sql<number>`count(*)` }).from(scan).where(inArray(scan.sessionId, sessionIds));
    // UPS/DHL parcels ship individually and are never assigned to a box —
    // only EPG parcels get consolidated into one (see ScanTable's "UPS /
    // DHL Parcels" unboxed section on the detail page) — so "parcels per
    // box" below is computed against this count, not totalPackages, or
    // UPS/DHL volume would inflate a ratio they were never part of.
    const [epgCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(scan)
      .where(and(inArray(scan.sessionId, sessionIds), eq(scan.carrier, "epg")));
    const [boxCountRow] = await db.select({ count: sql<number>`count(*)` }).from(box).where(inArray(box.sessionId, sessionIds));
    totalPackages = Number(scanCountRow?.count ?? 0);
    totalEpgPackages = Number(epgCountRow?.count ?? 0);
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
    totalEpgPackages,
    totalBoxes,
    avgPackagesPerShipment: sessions.length > 0 ? totalPackages / sessions.length : 0,
    avgBoxesPerShipment: sessions.length > 0 ? totalBoxes / sessions.length : 0,
    avgHoursToSubmit: durationsHours.length > 0 ? durationsHours.reduce((a, b) => a + b, 0) / durationsHours.length : null,
  };
}

export type EpgFinalMileTime = { avgDays: number | null; sampleSize: number };

/**
 * How long it takes an individual EPG parcel to actually reach the
 * customer, measured *after* it's already inside the master UPS
 * multi-piece shipment that consolidates every EPG box to the ePost Global
 * hub (see docs/PRD.md §7 and schema.ts's master_ups_tracking comment) —
 * i.e. hub arrival to final-mile delivery, not label-creation to delivery.
 * Only counts sessions/scans where both halves have actually delivered;
 * a still-in-transit parcel has no end timestamp to measure against yet
 * and is silently excluded rather than skewing the average with a partial
 * duration.
 */
export async function getEpgFinalMileTime(days: number): Promise<EpgFinalMileTime> {
  const rows = await db
    .select({
      masterUpsStatusAt: shipmentSession.masterUpsStatusAt,
      statusAt: scan.statusAt,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(
        submittedInWindow(days),
        eq(scan.carrier, "epg"),
        sql`${shipmentSession.masterUpsStatusLabel} ~* 'delivered'`,
        sql`${scan.statusLabel} ~* 'delivered'`,
        isNotNull(shipmentSession.masterUpsStatusAt),
        isNotNull(scan.statusAt),
      ),
    );

  const days_: number[] = [];
  for (const r of rows) {
    const hubDeliveredAt = parseCarrierTimestamp(r.masterUpsStatusAt!);
    const finalDeliveredAt = parseCarrierTimestamp(r.statusAt!);
    const diffDays = (finalDeliveredAt.getTime() - hubDeliveredAt.getTime()) / (24 * 60 * 60 * 1000);
    // Guards against the two sources disagreeing about order (a data
    // problem, not a real "delivered before it arrived" event) rather than
    // letting a negative duration drag the average down.
    if (diffDays >= 0) days_.push(diffDays);
  }

  return {
    avgDays: days_.length > 0 ? days_.reduce((a, b) => a + b, 0) / days_.length : null,
    sampleSize: days_.length,
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

export type CostByCarrierPoint = { carrier: Carrier; totalCost: number; avgCost: number | null; count: number };
export type CostStats = {
  totalCost: number;
  avgCostPerPackage: number | null;
  /** First non-null currency seen — this app ships from one warehouse, so mixed currencies aren't expected in practice. */
  currency: string | null;
  byCarrier: CostByCarrierPoint[];
};

/**
 * Real shipping cost over the window, from ShipStation label data
 * (lib/shipstation-cron.ts backfills `scan.shipstationCostAmount` for every
 * carrier). Only counts scans a label cost has actually been backfilled
 * for — a shipment with zero backfilled parcels yet just reads as $0/null,
 * not a false "free shipping" claim, since `count` and `avgCostPerPackage`
 * make that gap visible on the page rather than silently averaging over it.
 */
export async function getCostStats(days: number): Promise<CostStats> {
  const rows = await db
    .select({
      carrier: scan.carrier,
      totalCost: sql<number>`coalesce(sum(${scan.shipstationCostAmount}), 0)`,
      count: sql<number>`count(${scan.shipstationCostAmount})`,
      currency: sql<string | null>`max(${scan.shipstationCostCurrency})`,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(submittedInWindow(days))
    .groupBy(scan.carrier);

  let totalCost = 0;
  let totalCount = 0;
  let currency: string | null = null;
  const byCarrier: CostByCarrierPoint[] = [];
  for (const carrier of CARRIER_ORDER) {
    const row = rows.find((r) => r.carrier === carrier);
    const carrierTotal = Number(row?.totalCost ?? 0);
    const carrierCount = Number(row?.count ?? 0);
    if (row?.currency && !currency) currency = row.currency;
    totalCost += carrierTotal;
    totalCount += carrierCount;
    if (carrierCount > 0) {
      byCarrier.push({
        carrier,
        totalCost: Math.round(carrierTotal * 100) / 100,
        avgCost: Math.round((carrierTotal / carrierCount) * 100) / 100,
        count: carrierCount,
      });
    }
  }

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    avgCostPerPackage: totalCount > 0 ? Math.round((totalCost / totalCount) * 100) / 100 : null,
    currency,
    byCarrier,
  };
}

export type OnTimeDeliveryPoint = { carrier: Carrier; onTime: number; late: number; total: number; pct: number | null };

/**
 * % of delivered parcels that arrived at or before ShipStation's own
 * estimate, by carrier — see lookupShipstationTracking's comment in
 * lib/shipstation.ts for why this data source is flagged unverified. Only
 * counts parcels where both an estimate and an actual delivery date were
 * captured; a parcel still in transit (no actual date yet) is excluded
 * rather than counted as "on time" by default.
 */
export async function getOnTimeDeliveryStats(days: number): Promise<OnTimeDeliveryPoint[]> {
  const rows = await db
    .select({
      carrier: scan.carrier,
      estimatedAt: scan.shipstationEstimatedDeliveryAt,
      actualAt: scan.shipstationActualDeliveryAt,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(
        submittedInWindow(days),
        isNotNull(scan.shipstationEstimatedDeliveryAt),
        isNotNull(scan.shipstationActualDeliveryAt),
      ),
    );

  const byCarrier = new Map<Carrier, { onTime: number; late: number }>();
  for (const r of rows) {
    const carrier = r.carrier as Carrier;
    const entry = byCarrier.get(carrier) ?? { onTime: 0, late: 0 };
    const estimated = parseCarrierTimestamp(r.estimatedAt!);
    const actual = parseCarrierTimestamp(r.actualAt!);
    if (actual.getTime() <= estimated.getTime()) entry.onTime += 1;
    else entry.late += 1;
    byCarrier.set(carrier, entry);
  }

  return CARRIER_ORDER.filter((c) => byCarrier.has(c)).map((carrier) => {
    const entry = byCarrier.get(carrier)!;
    const total = entry.onTime + entry.late;
    return { carrier, onTime: entry.onTime, late: entry.late, total, pct: total > 0 ? (entry.onTime / total) * 100 : null };
  });
}

export type RateShopSavingsPoint = { carrier: Carrier; actualCost: number; bestRateCost: number; savings: number; count: number };
export type RateShopSavings = {
  totalActualCost: number;
  totalBestRateCost: number;
  totalSavings: number;
  count: number;
  byCarrier: RateShopSavingsPoint[];
};

/**
 * What was actually paid vs. the cheapest quote ShipStation's rate-estimate
 * endpoint found for the same parcel (lib/shipstation-rate-shop-cron.ts) —
 * see lib/shipstation-rates.ts's own comment for why this data source is
 * flagged unverified. A negative `savings` is a legitimate result (the
 * carrier actually used was already the cheapest option), not an error.
 * Only counts parcels where both figures are known.
 */
export async function getRateShopSavings(days: number): Promise<RateShopSavings> {
  const rows = await db
    .select({
      carrier: scan.carrier,
      actual: scan.shipstationCostAmount,
      best: scan.shipstationBestRateAmount,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(submittedInWindow(days), isNotNull(scan.shipstationCostAmount), isNotNull(scan.shipstationBestRateAmount)),
    );

  let totalActual = 0;
  let totalBest = 0;
  const byCarrierMap = new Map<Carrier, { actual: number; best: number; count: number }>();
  for (const r of rows) {
    const actual = r.actual!;
    const best = r.best!;
    totalActual += actual;
    totalBest += best;
    const carrier = r.carrier as Carrier;
    const entry = byCarrierMap.get(carrier) ?? { actual: 0, best: 0, count: 0 };
    entry.actual += actual;
    entry.best += best;
    entry.count += 1;
    byCarrierMap.set(carrier, entry);
  }

  const byCarrier = CARRIER_ORDER.filter((c) => byCarrierMap.has(c)).map((carrier) => {
    const e = byCarrierMap.get(carrier)!;
    return {
      carrier,
      actualCost: Math.round(e.actual * 100) / 100,
      bestRateCost: Math.round(e.best * 100) / 100,
      savings: Math.round((e.actual - e.best) * 100) / 100,
      count: e.count,
    };
  });

  return {
    totalActualCost: Math.round(totalActual * 100) / 100,
    totalBestRateCost: Math.round(totalBest * 100) / 100,
    totalSavings: Math.round((totalActual - totalBest) * 100) / 100,
    count: rows.length,
    byCarrier,
  };
}

export type ShippingMarginPoint = { carrier: Carrier; totalCost: number; totalCharged: number; margin: number; count: number };
export type ShippingMargin = {
  totalCost: number;
  totalCharged: number;
  /** charged − cost, summed across every parcel with both figures known. Negative means the warehouse is losing money on shipping overall, not just on individual flagged parcels. */
  netMargin: number;
  marginPct: number | null;
  count: number;
  byCarrier: ShippingMarginPoint[];
};

/**
 * The single "are we gaining or losing money on shipping" number — total
 * cost paid (ShipStation) vs. total charged to the customer (Shopify),
 * summed across every parcel where both are known. Distinct from
 * lib/shipment-alerts.ts's shipping-loss exceptions, which only flag
 * individual parcels that lost money; this is the net across all of them,
 * so a handful of losses can still net positive (or a lot of thin margins
 * can still net negative) — the number a business decision actually needs.
 */
export async function getShippingMargin(days: number): Promise<ShippingMargin> {
  const rows = await db
    .select({
      carrier: scan.carrier,
      totalCost: sql<number>`coalesce(sum(${scan.shipstationCostAmount}), 0)`,
      totalCharged: sql<number>`coalesce(sum(${scan.customerShippingAmount}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(submittedInWindow(days), isNotNull(scan.shipstationCostAmount), isNotNull(scan.customerShippingAmount)),
    )
    .groupBy(scan.carrier);

  let totalCost = 0;
  let totalCharged = 0;
  let count = 0;
  const byCarrier: ShippingMarginPoint[] = [];
  for (const carrier of CARRIER_ORDER) {
    const row = rows.find((r) => r.carrier === carrier);
    if (!row) continue;
    const cost = Number(row.totalCost);
    const charged = Number(row.totalCharged);
    const c = Number(row.count);
    totalCost += cost;
    totalCharged += charged;
    count += c;
    byCarrier.push({ carrier, totalCost: round2(cost), totalCharged: round2(charged), margin: round2(charged - cost), count: c });
  }

  return {
    totalCost: round2(totalCost),
    totalCharged: round2(totalCharged),
    netMargin: round2(totalCharged - totalCost),
    marginPct: totalCharged > 0 ? ((totalCharged - totalCost) / totalCharged) * 100 : null,
    count,
    byCarrier,
  };
}

export type ExceptionBreakdownPoint = { carrier: Carrier; count: number; topReason: string | null };
export type ExceptionCategoryPoint = { category: ExceptionCategory; count: number };
export type ExceptionBreakdown = {
  totalCount: number;
  byCarrier: ExceptionBreakdownPoint[];
  topReasonsOverall: { label: string; count: number }[];
  /** Same exceptions, rolled up by root cause instead of by exact wording — see categorizeException's comment for why that's a different, more useful cut of the same data. */
  byCategory: ExceptionCategoryPoint[];
};

/**
 * Which carrier throws the most exceptions, and what they actually say —
 * "most exceptions" is only useful alongside *why*, not just a count.
 * Reuses the same EXCEPTION_STATUS_RE and case/whitespace-normalization
 * approach as getStatusBreakdown, scoped to just the flagged subset.
 */
export async function getExceptionBreakdown(days: number): Promise<ExceptionBreakdown> {
  const rows = await db
    .select({ carrier: scan.carrier, statusLabel: scan.statusLabel })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(and(submittedInWindow(days), isNotNull(scan.statusLabel)));

  const exceptionRows = rows.filter((r) => EXCEPTION_STATUS_RE.test(r.statusLabel!));

  const byCarrierCount = new Map<Carrier, number>();
  const byCarrierReasons = new Map<Carrier, Map<string, { label: string; count: number }>>();
  const overallReasons = new Map<string, { label: string; count: number }>();
  const byCategoryCount = new Map<ExceptionCategory, number>();

  for (const r of exceptionRows) {
    const carrier = r.carrier as Carrier;
    const raw = r.statusLabel!.trim();
    const key = raw.toLowerCase();

    byCarrierCount.set(carrier, (byCarrierCount.get(carrier) ?? 0) + 1);
    if (!byCarrierReasons.has(carrier)) byCarrierReasons.set(carrier, new Map());
    const carrierMap = byCarrierReasons.get(carrier)!;
    const existing = carrierMap.get(key);
    if (existing) existing.count += 1;
    else carrierMap.set(key, { label: raw, count: 1 });

    const existingOverall = overallReasons.get(key);
    if (existingOverall) existingOverall.count += 1;
    else overallReasons.set(key, { label: raw, count: 1 });

    const category = categorizeException(raw);
    byCategoryCount.set(category, (byCategoryCount.get(category) ?? 0) + 1);
  }

  const byCarrier: ExceptionBreakdownPoint[] = CARRIER_ORDER.filter((c) => byCarrierCount.has(c)).map((carrier) => {
    const count = byCarrierCount.get(carrier)!;
    const reasons = [...(byCarrierReasons.get(carrier)?.values() ?? [])].sort((a, b) => b.count - a.count);
    return { carrier, count, topReason: reasons[0]?.label ?? null };
  });

  const byCategory: ExceptionCategoryPoint[] = [...byCategoryCount.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalCount: exceptionRows.length,
    byCarrier,
    topReasonsOverall: [...overallReasons.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    byCategory,
  };
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

/**
 * Top current carrier-status labels across submitted shipments in the
 * window — a live read of "where is everything" (delivered vs in-transit
 * vs exception) without opening every shipment.
 *
 * Grouped in JS on a case/whitespace-normalized key, not the raw SQL group
 * — the same real-world status comes back worded slightly differently per
 * carrier ("Delivered" from EPG vs UPS's "DELIVERED " with a trailing
 * space), which fragmented what should be one bar into several. Only
 * collapses exact matches once normalized, not different-but-related
 * wording (e.g. "Arrived at Facility" stays separate from "Departed from
 * Facility") — that would need a real per-carrier status taxonomy, which
 * is a bigger, more error-prone undertaking than fixing formatting noise.
 */
export async function getStatusBreakdown(days: number): Promise<StatusBreakdownPoint[]> {
  const rows = await db
    .select({ label: scan.statusLabel, count: sql<number>`count(*)` })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(and(submittedInWindow(days), isNotNull(scan.statusLabel)))
    .groupBy(scan.statusLabel);

  const byKey = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    const raw = (r.label ?? "Unknown").trim();
    const key = raw.toLowerCase();
    const count = Number(r.count);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { label: raw, count });
      continue;
    }
    existing.count += count;
    // Prefer a display label that isn't SHOUTING when variants disagree on
    // case — cosmetic only, doesn't affect which bucket anything counts in.
    if (raw !== raw.toUpperCase() && existing.label === existing.label.toUpperCase()) {
      existing.label = raw;
    }
  }

  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, 10);
}

export type DhlPickupStats = {
  requested: number;
  cancelled: number;
  failed: number;
  totalParcels: number;
  totalWeightLb: number;
  avgWeightLb: number | null;
  /** cancelled / (requested + cancelled) — how much of DHL pickup activity ends up cancelled instead of actually picked up; null with no booked pickups to judge yet. A high rate signals a scheduling/readiness process problem, not a carrier problem. */
  cancelRatePct: number | null;
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

  const stats: DhlPickupStats = {
    requested: 0,
    cancelled: 0,
    failed: 0,
    totalParcels: 0,
    totalWeightLb: 0,
    avgWeightLb: null,
    cancelRatePct: null,
  };
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
  const bookedActivity = stats.requested + stats.cancelled;
  stats.cancelRatePct = bookedActivity > 0 ? round2((stats.cancelled / bookedActivity) * 100) : null;
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

export type WeekdayVolumePoint = WeekdayCarrierPoint;

/** Package volume summed by day of week across the whole window, split by carrier — which day of the week actually ships the most, and which carrier is behind it, independent of any one calendar date. */
export async function getWeekdayVolume(days: number): Promise<WeekdayVolumePoint[]> {
  const rows = await db
    .select({ shipDate: shipmentSession.shipDate, carrier: scan.carrier, count: sql<number>`count(*)` })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(submittedInWindow(days))
    .groupBy(shipmentSession.shipDate, scan.carrier);

  return buildWeekdayVolume(rows.map((r) => ({ shipDate: r.shipDate, carrier: r.carrier as Carrier, count: Number(r.count) })));
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

export type CarrierMarginTrendResult = { windowDays: number; carriers: CarrierMarginTrend[] };

/**
 * Per-carrier margin over time: this window vs. the equal-length window
 * before it, plus full 7-day buckets within this window. Answers "is this
 * carrier's margin thin because rates crept up, or was it always thin" —
 * which a single window total can't. Same both-figures-known filter as
 * getShippingMargin, so the numbers tie out to the margin tiles.
 */
export async function getCarrierMarginTrend(days: number): Promise<CarrierMarginTrendResult> {
  const rows = await db
    .select({
      carrier: scan.carrier,
      shipDate: shipmentSession.shipDate,
      cost: sql<number>`coalesce(sum(${scan.shipstationCostAmount}), 0)`,
      charged: sql<number>`coalesce(sum(${scan.customerShippingAmount}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(
        eq(shipmentSession.status, "submitted"),
        isNull(shipmentSession.deletedAt),
        sql`${shipmentSession.shipDate} >= ${calendarCutoff(days * 2)}`,
        isNotNull(scan.shipstationCostAmount),
        isNotNull(scan.customerShippingAmount),
      ),
    )
    .groupBy(scan.carrier, shipmentSession.shipDate);

  const marginRows: MarginDayRow[] = rows.map((r) => ({
    carrier: r.carrier as Carrier,
    shipDate: r.shipDate,
    cost: Number(r.cost),
    charged: Number(r.charged),
    count: Number(r.count),
  }));
  return { windowDays: days, carriers: buildMarginTrend(marginRows, days, localCalendarDate()) };
}

export type DataGapKind = "no-order-match" | "no-charge" | "no-cost";
export type DataGapCarrierPoint = {
  carrier: Carrier;
  total: number;
  unmatched: number;
  missingCharge: number;
  chargedNoCost: number;
};
export type DataGapExample = {
  scanId: string;
  sessionId: string;
  trackingNumber: string;
  carrier: Carrier;
  shipDate: string;
  gaps: DataGapKind[];
};
export type DataGaps = {
  totalParcels: number;
  /** Parcels with both a label cost and a customer-charged amount — exactly the set every margin figure on the page is computed from. */
  marginCovered: number;
  /** Parcels the margin figures silently exclude (totalParcels − marginCovered). */
  marginExcluded: number;
  /** No Shopify order matched the scan (orderGid is null) — so no customer-charged amount either. */
  unmatched: number;
  /** A label cost is known but the customer-charged amount isn't: money went out with nothing to compare it to. `costExposure` is the label cost on those parcels. */
  missingCharge: number;
  costExposure: number;
  /** A customer-charged amount is known but the label cost isn't: a loss on these parcels would be invisible. `chargedUncosted` is what customers paid on them. */
  chargedNoCost: number;
  chargedUncosted: number;
  byCarrier: DataGapCarrierPoint[];
  /** Most recent parcels with at least one gap, newest first. */
  examples: DataGapExample[];
};

const DATA_GAP_EXAMPLE_LIMIT = 10;

/**
 * The parcels the margin/cost figures leave out, and why — so a gap between
 * "parcels shipped" and "parcels with margin data" is a number on the page,
 * not something to reverse-engineer by cross-referencing counts across
 * sections. Three distinct failure modes, kept separate because they have
 * different fixes: no order match (webhook/ERef/order-index), matched order
 * with no shipping charge on it, and a charge with no ShipStation label cost
 * (labels cron).
 */
export async function getDataGaps(days: number): Promise<DataGaps> {
  const [rows, exampleRows] = await Promise.all([
    db
      .select({
        carrier: scan.carrier,
        total: sql<number>`count(*)`,
        covered: sql<number>`count(*) filter (where ${scan.shipstationCostAmount} is not null and ${scan.customerShippingAmount} is not null)`,
        unmatched: sql<number>`count(*) filter (where ${scan.orderGid} is null)`,
        missingCharge: sql<number>`count(*) filter (where ${scan.shipstationCostAmount} is not null and ${scan.customerShippingAmount} is null)`,
        costExposure: sql<number>`coalesce(sum(${scan.shipstationCostAmount}) filter (where ${scan.customerShippingAmount} is null), 0)`,
        chargedNoCost: sql<number>`count(*) filter (where ${scan.customerShippingAmount} is not null and ${scan.shipstationCostAmount} is null)`,
        chargedUncosted: sql<number>`coalesce(sum(${scan.customerShippingAmount}) filter (where ${scan.shipstationCostAmount} is null), 0)`,
      })
      .from(scan)
      .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
      .where(submittedInWindow(days))
      .groupBy(scan.carrier),
    db
      .select({
        scanId: scan.id,
        sessionId: scan.sessionId,
        trackingNumber: scan.trackingNumber,
        carrier: scan.carrier,
        shipDate: shipmentSession.shipDate,
        orderGid: scan.orderGid,
        cost: scan.shipstationCostAmount,
        charged: scan.customerShippingAmount,
      })
      .from(scan)
      .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
      .where(
        and(
          submittedInWindow(days),
          or(isNull(scan.orderGid), isNull(scan.shipstationCostAmount), isNull(scan.customerShippingAmount)),
        ),
      )
      .orderBy(desc(scan.scannedAt))
      .limit(DATA_GAP_EXAMPLE_LIMIT),
  ]);

  let totalParcels = 0;
  let marginCovered = 0;
  let unmatched = 0;
  let missingCharge = 0;
  let costExposure = 0;
  let chargedNoCost = 0;
  let chargedUncosted = 0;
  const byCarrier: DataGapCarrierPoint[] = [];
  for (const carrier of CARRIER_ORDER) {
    const r = rows.find((row) => row.carrier === carrier);
    if (!r) continue;
    const point = {
      carrier,
      total: Number(r.total),
      unmatched: Number(r.unmatched),
      missingCharge: Number(r.missingCharge),
      chargedNoCost: Number(r.chargedNoCost),
    };
    totalParcels += point.total;
    marginCovered += Number(r.covered);
    unmatched += point.unmatched;
    missingCharge += point.missingCharge;
    costExposure += Number(r.costExposure);
    chargedNoCost += point.chargedNoCost;
    chargedUncosted += Number(r.chargedUncosted);
    byCarrier.push(point);
  }

  const examples: DataGapExample[] = exampleRows.map((r) => {
    const gaps: DataGapKind[] = [];
    if (r.orderGid === null) gaps.push("no-order-match");
    else if (r.charged === null) gaps.push("no-charge");
    if (r.cost === null) gaps.push("no-cost");
    return {
      scanId: r.scanId,
      sessionId: r.sessionId,
      trackingNumber: r.trackingNumber,
      carrier: r.carrier as Carrier,
      shipDate: r.shipDate,
      gaps,
    };
  });

  return {
    totalParcels,
    marginCovered,
    marginExcluded: totalParcels - marginCovered,
    unmatched,
    missingCharge,
    costExposure: round2(costExposure),
    chargedNoCost,
    chargedUncosted: round2(chargedUncosted),
    byCarrier,
    examples,
  };
}

export type IntegrationHealth = {
  rateShop: PipelineCounts & PipelineDiagnosis & { originConfigured: boolean };
  onTime: PipelineCounts & PipelineDiagnosis;
};

/**
 * Whether the two ShipStation-backed "unverified" metrics (rate-shop
 * savings, on-time delivery) are empty because there's nothing to report or
 * because the pipeline behind them isn't producing anything. Counts each
 * parcel's progress through the backfill (eligible → attempted → populated)
 * and hands them to the pure diagnosis functions for a plain-language cause.
 */
export async function getIntegrationHealth(days: number): Promise<IntegrationHealth> {
  const [[row], originSettings] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)`,
        rateEligible: sql<number>`count(*) filter (where ${scan.shipstationWeightLb} is not null)`,
        rateAttempted: sql<number>`count(*) filter (where ${scan.shipstationWeightLb} is not null and ${scan.shipstationBestRateCheckedAt} is not null)`,
        ratePopulated: sql<number>`count(*) filter (where ${scan.shipstationBestRateAmount} is not null and ${scan.shipstationCostAmount} is not null)`,
        timeEligible: sql<number>`count(*) filter (where ${scan.shipstationCarrierCode} is not null)`,
        timeAttempted: sql<number>`count(*) filter (where ${scan.shipstationCarrierCode} is not null and ${scan.shipstationDeliveryCheckedAt} is not null)`,
        timePopulated: sql<number>`count(*) filter (where ${scan.shipstationEstimatedDeliveryAt} is not null and ${scan.shipstationActualDeliveryAt} is not null)`,
      })
      .from(scan)
      .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
      .where(submittedInWindow(days)),
    getDhlPickupSettings(),
  ]);

  const total = Number(row?.total ?? 0);
  const rateCounts: PipelineCounts = {
    total,
    eligible: Number(row?.rateEligible ?? 0),
    attempted: Number(row?.rateAttempted ?? 0),
    populated: Number(row?.ratePopulated ?? 0),
  };
  const timeCounts: PipelineCounts = {
    total,
    eligible: Number(row?.timeEligible ?? 0),
    attempted: Number(row?.timeAttempted ?? 0),
    populated: Number(row?.timePopulated ?? 0),
  };
  const originConfigured = originSettings !== null;

  return {
    rateShop: { ...rateCounts, ...diagnoseRateShop(rateCounts, originConfigured), originConfigured },
    onTime: { ...timeCounts, ...diagnoseOnTime(timeCounts) },
  };
}
