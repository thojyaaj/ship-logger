/**
 * Timestamps in this app come from two sources that use different formats:
 * SQLite's `(current_timestamp)` column default ("2026-08-30 20:20:58", no
 * timezone marker) and JS-side `new Date().toISOString()` ("2026-08-30T20:20:58.345Z",
 * already has one). Both are UTC. Blindly appending "Z" to the second one
 * produces "...345ZZ", which Date() can't parse — hence this helper.
 */
export function parseDbTimestamp(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
}

// This is a single-warehouse app (see PRD — multi-warehouse is explicitly
// out of scope), so one fixed zone stands in for "here" everywhere a
// server-rendered "local" time or calendar day is needed. Not a per-user
// preference: there's exactly one warehouse, not one per packer.
const WAREHOUSE_TZ = "America/Chicago";

export function formatDbTimestamp(value: string): string {
  return parseDbTimestamp(value).toLocaleString();
}

/**
 * Same value, formatted in the warehouse's fixed local time rather than the
 * renderer's own default. For server components: there's no visitor context
 * to default to correctly there (Vercel's Node runtime defaults to UTC, not
 * wherever the warehouse actually is, and no TZ env var is set), so a bare
 * toLocaleString() on the server silently mislabels UTC time as local. Client
 * components should keep using plain formatDbTimestamp() instead — a no-arg
 * toLocaleString() running in the browser already correctly resolves to the
 * viewer's own locale/timezone and doesn't need this.
 */
export function formatWarehouseTimestamp(value: string): string {
  // Explicit field list (not the bare no-arg toLocaleString overload used
  // above) so seconds are dropped — a packer reading "Opened"/"Submitted"
  // doesn't need second-level precision, and it was adding visual noise.
  return parseDbTimestamp(value).toLocaleString("en-US", {
    timeZone: WAREHOUSE_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Formats a carrier-supplied tracking timestamp for display. UPS returns its
 * status time as an unzoned `YYYYMMDD HHMMSS` wall-clock value. It must not
 * be converted between timezones, or the carrier's event time would shift.
 */
export function formatCarrierTimestamp(value: string): string {
  const upsMatch = /^(\d{4})(\d{2})(\d{2})\s?(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };

  if (upsMatch) {
    const [, year, month, day, hour, minute, second] = upsMatch;
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
      new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))),
    );
  }

  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: WAREHOUSE_TZ }).format(
    parseDbTimestamp(value),
  );
}

/**
 * Matches SQLite's `(current_timestamp)` column-default format exactly
 * ("2026-08-30 20:20:58", space-separated, no zone marker) so that
 * app-written timestamps sort correctly against DB-default ones in plain
 * string comparisons (used by the EPG status cron's lookback filter).
 */
export function toSqlTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export function nowSqlTimestamp(): string {
  return toSqlTimestamp(new Date());
}

/**
 * YYYY-MM-DD in the warehouse's fixed timezone. `toISOString().slice(0, 10)`
 * is UTC and will stamp a US-evening warehouse session as tomorrow — used
 * anywhere a calendar day (shipDate, a chart's date bucket, a cron's
 * lookback window) needs to match what a human standing at the warehouse
 * would call "today." Deliberately *not* `date.getFullYear()`/etc (the
 * process's own local timezone) — Vercel's Node runtime defaults to UTC
 * with no TZ env var set here, so "process-local" is actually UTC in
 * production, not the warehouse's zone, which reintroduces the exact bug
 * this function exists to avoid.
 */
export function localCalendarDate(date: Date = new Date()): string {
  // en-CA's default date format is ISO-shaped (YYYY-MM-DD) — a convenient
  // way to get that shape straight out of Intl without hand-assembling it.
  return new Intl.DateTimeFormat("en-CA", { timeZone: WAREHOUSE_TZ }).format(date);
}

/**
 * "HH:MM" (24-hour) wall-clock time in the warehouse's fixed zone for a DB
 * timestamp — used to compare a submission time against a DHL pickup
 * window's cutoffs. en-GB (not en-US) with hour12:false: some ICU builds
 * render en-US + hour12:false as "24:00" instead of "00:00" at midnight,
 * which breaks minute-of-day arithmetic; en-GB doesn't have that quirk.
 */
export function warehouseLocalTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: WAREHOUSE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parseDbTimestamp(value));
}

/** Next calendar date after `date` ("YYYY-MM-DD"). Pure calendar-day math —
 * done via Date.UTC (not local-timezone Date arithmetic) so it can't be
 * thrown off by a DST transition, since no actual timezone or instant is
 * involved, just incrementing a day-of-month integer. */
export function nextCalendarDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Combines a calendar date and a "HH:MM" wall-clock time into a full
 * ISO-8601 timestamp carrying the warehouse's *actual* UTC offset for that
 * specific date — e.g. "2026-07-04T09:00:00-05:00" in CDT vs
 * "2026-01-04T09:00:00-06:00" in CST. Needed by anything that hands a
 * timestamp to an external API expecting a real offset (DHL's pickup
 * scheduling), not just a bare local time.
 *
 * Not a fixed "-06:00" constant: `America/Chicago` observes daylight saving,
 * so the correct offset depends on which side of the DST transition the date
 * falls on. Getting this wrong doesn't error, it just puts the pickup window
 * an hour off — the kind of bug that's invisible until enough of the year has
 * passed to hit the other side of the transition, which is exactly why it's
 * computed here from Intl rather than hardcoded.
 */
export function warehouseIsoWithOffset(shipDate: string, hhmm: string): string {
  // A local Date constructed from the same wall-clock values, purely to ask
  // Intl "what offset does the warehouse zone use around this date" — the
  // constructed Date's own zone is irrelevant, only the y/m/d/h/m values are
  // used to answer that question for the correct side of any DST transition.
  const [y, m, d] = shipDate.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const probe = new Date(y, m - 1, d, hh, mm);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: WAREHOUSE_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(probe);
  // e.g. "GMT-5" or "GMT-6" — never fractional for this zone.
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(raw);
  const sign = match?.[1] ?? "+";
  const offsetH = (match?.[2] ?? "0").padStart(2, "0");
  const offsetM = (match?.[3] ?? "00").padStart(2, "0");

  return `${shipDate}T${hhmm}:00${sign}${offsetH}:${offsetM}`;
}
