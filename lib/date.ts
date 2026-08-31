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

export function formatDbTimestamp(value: string): string {
  return parseDbTimestamp(value).toLocaleString();
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
 * YYYY-MM-DD in the process-local timezone. `toISOString().slice(0, 10)` is
 * UTC and will stamp a US-evening warehouse session as tomorrow — used
 * anywhere a calendar day (shipDate, a chart's date bucket, a cron's
 * lookback window) needs to match what a human standing at the warehouse
 * would call "today," not what UTC currently reads.
 */
export function localCalendarDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
