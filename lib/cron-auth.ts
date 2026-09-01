import "server-only";
import crypto from "node:crypto";

/**
 * Shared guard for the Vercel Cron endpoints. Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` automatically when CRON_SECRET is
 * set on the project — see vercel.json.
 *
 * Fails CLOSED in production. The previous `if (secret) { ...check... }` shape
 * skipped verification entirely whenever the env var was unset or empty, so a
 * deploy that simply forgot the variable silently published both endpoints.
 * That is not a theoretical cost: each unauthenticated hit drives a full pass
 * of sequential UPS Track / Shopify Admin API calls plus a write per row, so
 * anyone who found the URL could burn API quota and churn the database in a
 * loop. Outside production the check stays optional so `npm run dev` works
 * with zero setup.
 */
export function cronRequestIsAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";

  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  // Length must match before timingSafeEqual — it throws on a length mismatch
  // rather than returning false. The compare itself is constant-time so the
  // secret can't be recovered byte-by-byte from response timing.
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
