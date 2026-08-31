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
