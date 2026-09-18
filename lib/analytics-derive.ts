import type { Carrier } from "./carrier";

/**
 * Pure (no DB, no server-only) derivations behind the Analytics page's
 * margin-trend, weekday-by-carrier, and integration-health readouts — split
 * out of lib/analytics.ts so the date-bucketing and diagnosis logic can be
 * exercised without a database.
 */

const CARRIERS: Carrier[] = ["epg", "ups", "dhl", "unknown"];

/** A comparison needs this many parcels on each side, or a "margin dropped 8 points" reading is mostly noise from one odd parcel. */
export const MIN_TREND_SAMPLE = 5;
const TREND_BUCKET_DAYS = 7;

/** Whole calendar days from `from` to `to` ("YYYY-MM-DD" both) — via Date.UTC so DST can't skew it; no instant is involved. */
export function calendarDaysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Per-carrier margin trend
// ---------------------------------------------------------------------------

/** One (carrier, ship day) aggregate of parcels with BOTH a label cost and a customer-charged amount. */
export type MarginDayRow = { carrier: Carrier; shipDate: string; cost: number; charged: number; count: number };

export type MarginSlice = {
  count: number;
  avgCost: number | null;
  avgCharged: number | null;
  /** (charged − cost) / charged, as a percentage. Null when nothing was charged. */
  marginPct: number | null;
};

export type MarginTrendWeek = MarginSlice & {
  /** 0 = the most recent full 7-day bucket, counting back from today. */
  weeksAgo: number;
};

export type CarrierMarginTrend = {
  carrier: Carrier;
  current: MarginSlice;
  previous: MarginSlice;
  /** Percentage-point change in margin (current − previous). Null when either window is under MIN_TREND_SAMPLE. */
  marginPctChange: number | null;
  /** % change in average label cost per parcel — the "rate creep" signal, independent of what customers were charged. */
  avgCostPctChange: number | null;
  /** % change in average amount charged per parcel. */
  avgChargedPctChange: number | null;
  /** Oldest → newest. Empty when the window is shorter than one full bucket. */
  weekly: MarginTrendWeek[];
};

function emptySlice(): { count: number; cost: number; charged: number } {
  return { count: 0, cost: 0, charged: 0 };
}

function finishSlice(s: { count: number; cost: number; charged: number }): MarginSlice {
  return {
    count: s.count,
    avgCost: s.count > 0 ? s.cost / s.count : null,
    avgCharged: s.count > 0 ? s.charged / s.count : null,
    marginPct: s.charged > 0 ? ((s.charged - s.cost) / s.charged) * 100 : null,
  };
}

function pctDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Buckets `rows` (which must span the last `2 * days` calendar days) into the
 * current window, the equal-length window before it, and — within the
 * current window — full 7-day buckets counted back from `today`. Only full
 * buckets are emitted (30d → 4, 90d → 12, 7d → 1) so no point on the trend
 * line is built from a stub of two or three days.
 */
export function buildMarginTrend(rows: MarginDayRow[], days: number, today: string): CarrierMarginTrend[] {
  const weekCount = Math.floor(days / TREND_BUCKET_DAYS);
  const result: CarrierMarginTrend[] = [];

  for (const carrier of CARRIERS) {
    const current = emptySlice();
    const previous = emptySlice();
    const weeks = Array.from({ length: weekCount }, emptySlice);

    for (const r of rows) {
      if (r.carrier !== carrier) continue;
      const daysAgo = calendarDaysBetween(r.shipDate, today);
      if (daysAgo < 0) continue;
      const target = daysAgo < days ? current : daysAgo < 2 * days ? previous : null;
      if (!target) continue;
      target.count += r.count;
      target.cost += r.cost;
      target.charged += r.charged;
      if (daysAgo < days) {
        const week = Math.floor(daysAgo / TREND_BUCKET_DAYS);
        if (week < weekCount) {
          weeks[week].count += r.count;
          weeks[week].cost += r.cost;
          weeks[week].charged += r.charged;
        }
      }
    }

    if (current.count === 0 && previous.count === 0) continue;

    const currentSlice = finishSlice(current);
    const previousSlice = finishSlice(previous);
    const comparable = currentSlice.count >= MIN_TREND_SAMPLE && previousSlice.count >= MIN_TREND_SAMPLE;

    result.push({
      carrier,
      current: currentSlice,
      previous: previousSlice,
      marginPctChange:
        comparable && currentSlice.marginPct !== null && previousSlice.marginPct !== null
          ? currentSlice.marginPct - previousSlice.marginPct
          : null,
      avgCostPctChange: comparable ? pctDelta(currentSlice.avgCost, previousSlice.avgCost) : null,
      avgChargedPctChange: comparable ? pctDelta(currentSlice.avgCharged, previousSlice.avgCharged) : null,
      weekly: weeks.map((w, weeksAgo) => ({ weeksAgo, ...finishSlice(w) })).reverse(),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Weekday volume, split by carrier
// ---------------------------------------------------------------------------

export type WeekdayCarrierRow = { carrier: Carrier; shipDate: string; count: number };

export type WeekdayCarrierPoint = {
  weekday: number;
  label: string;
  count: number;
  /** Distinct calendar days in the window that had shipments on this weekday — what "avg per day" divides by, so a weekday that simply occurred more often isn't mistaken for a busier one. */
  shipDays: number;
  byCarrier: Record<Carrier, number>;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildWeekdayVolume(rows: WeekdayCarrierRow[]): WeekdayCarrierPoint[] {
  const points: WeekdayCarrierPoint[] = WEEKDAY_LABELS.map((label, weekday) => ({
    weekday,
    label,
    count: 0,
    shipDays: 0,
    byCarrier: { epg: 0, ups: 0, dhl: 0, unknown: 0 },
  }));
  const seenDays = new Set<string>();

  for (const r of rows) {
    // shipDate is a plain "YYYY-MM-DD" calendar day, not an instant — parsed
    // as UTC midnight purely to ask "which weekday is this", never rendered
    // or compared as a real timestamp, so there's no timezone to get wrong.
    const [y, m, d] = r.shipDate.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const point = points[weekday];
    point.count += r.count;
    point.byCarrier[r.carrier] += r.count;
    if (!seenDays.has(r.shipDate)) {
      seenDays.add(r.shipDate);
      point.shipDays += 1;
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Enrichment-pipeline health (rate-shop quotes, delivery estimates)
// ---------------------------------------------------------------------------

/**
 * Where each parcel in the window sits in a ShipStation backfill pipeline.
 * "Empty" analytics can mean four very different things — never attempted,
 * blocked upstream, attempted-and-answered-with-nothing, or answered — and
 * only the counts tell them apart.
 */
export type PipelineCounts = {
  /** All parcels in the window. */
  total: number;
  /** Parcels that satisfy the pipeline's prerequisite (labels backfilled), i.e. that the cron is allowed to look at. */
  eligible: number;
  /** Eligible parcels the cron has tried at least once. */
  attempted: number;
  /** Parcels holding a usable result (a quote, or a delivery estimate). */
  populated: number;
};

export type PipelineStatus = "ok" | "empty" | "partial";

export type PipelineDiagnosis = {
  status: PipelineStatus;
  /** One plain-language sentence naming the most likely cause. Null when status is "ok". */
  reason: string | null;
};

/** Rate-shop quotes need the warehouse origin address (DHL pickup settings) AND label measurements before the cron does anything. */
export function diagnoseRateShop(counts: PipelineCounts, originConfigured: boolean): PipelineDiagnosis {
  if (counts.populated > 0) {
    return counts.populated < counts.eligible / 2
      ? {
          status: "partial",
          reason: `Only ${counts.populated} of ${counts.eligible} eligible parcels have a rate quote — the rest are still pending or ShipStation returned no rates for them.`,
        }
      : { status: "ok", reason: null };
  }
  if (!originConfigured) {
    return {
      status: "empty",
      reason:
        "The rate-shop cron is skipping every run because the warehouse origin address isn't set (DHL pickup settings on the Admin page). Nothing has been compared, so this is missing data — not \"no better rate available.\"",
    };
  }
  if (counts.eligible === 0) {
    return {
      status: "empty",
      reason:
        "No parcels in this window have label weight/dimensions backfilled yet, which the rate-shop cron needs first. Missing data — not \"no better rate available.\"",
    };
  }
  if (counts.attempted === 0) {
    return {
      status: "empty",
      reason: `The rate-shop cron hasn't attempted any of the ${counts.eligible} eligible parcels yet. Missing data — not "no better rate available."`,
    };
  }
  return {
    status: "empty",
    reason: `The rate-shop cron tried ${counts.attempted} parcels and ShipStation returned no usable rate for any of them. That points to a broken integration (the rates endpoint's response shape is unverified — see lib/shipstation-rates.ts and the [shipstation-rates][DIAG] logs), not "no better rate available."`,
  };
}

/** Delivery estimates need the carrier code from the labels cron before the delivery cron looks a parcel up. */
export function diagnoseOnTime(counts: PipelineCounts): PipelineDiagnosis {
  if (counts.populated > 0) {
    return counts.populated < counts.eligible / 2
      ? {
          status: "partial",
          reason: `Only ${counts.populated} of ${counts.eligible} eligible parcels have both an estimated and an actual delivery date — the rest are in transit or ShipStation returned no dates.`,
        }
      : { status: "ok", reason: null };
  }
  if (counts.eligible === 0) {
    return {
      status: "empty",
      reason:
        "No parcels in this window have a ShipStation carrier code yet (the labels cron sets it), which the delivery cron needs first. Missing data — not a clean on-time record.",
    };
  }
  if (counts.attempted === 0) {
    return {
      status: "empty",
      reason: `The delivery cron hasn't attempted any of the ${counts.eligible} eligible parcels yet. Missing data — not a clean on-time record.`,
    };
  }
  return {
    status: "empty",
    reason: `The delivery cron tried ${counts.attempted} parcels and ShipStation returned no delivery dates for any of them. That points to a broken integration (the tracking endpoint is unverified — see lib/shipstation.ts and the [shipstation-tracking][DIAG] logs), not a clean on-time record.`,
  };
}
