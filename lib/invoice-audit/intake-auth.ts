import "server-only";
import crypto from "node:crypto";

/**
 * HMAC request signing for the invoice intake endpoint
 * (app/api/v1/invoices/<carrier>) — a server-to-server surface called by
 * automation holding its own secret, never by a browser session.
 *
 * Canonical string, one field per line, in this exact order:
 *
 *   POST
 *   /api/v1/invoices/epg
 *   <timestamp: unix seconds>
 *   <sha256 hex of the raw request body>
 *
 * Signature = lowercase hex HMAC-SHA256(secret, canonical string), sent as
 * `X-ShipLogger-Signature`, with the timestamp in `X-ShipLogger-Timestamp`
 * and the caller's id in `X-ShipLogger-Caller`. The reference client is
 * scripts/apps-script/epg-invoice-intake.gs — change both together.
 *
 * One secret per caller: adding a new caller is a new entry in CALLERS
 * plus its own env var, so revoking or leaking one never affects another.
 */
const CALLERS: Record<string, string> = {
  "gmail-apps-script": "INVOICE_INTAKE_SECRET_GMAIL",
};

// Covers ordinary clock skew between Google and Vercel. A replay inside the
// window is still harmless: intake is idempotent on invoice number.
const MAX_SKEW_SECONDS = 5 * 60;

export type IntakeAuthResult = { ok: true; caller: string } | { ok: false; status: 401 | 503; reason: string };

export function sha256Hex(body: Uint8Array): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export function signIntakeRequest(secret: string, method: string, path: string, timestamp: string, bodySha256: string): string {
  return crypto.createHmac("sha256", secret).update(`${method}\n${path}\n${timestamp}\n${bodySha256}`).digest("hex");
}

export function verifyIntakeRequest(
  req: Request,
  path: string,
  body: Uint8Array,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): IntakeAuthResult {
  const caller = req.headers.get("x-shiplogger-caller") ?? "";
  const timestamp = req.headers.get("x-shiplogger-timestamp") ?? "";
  const signature = req.headers.get("x-shiplogger-signature") ?? "";

  const envName = Object.hasOwn(CALLERS, caller) ? CALLERS[caller] : undefined;
  if (!envName) return { ok: false, status: 401, reason: "unknown caller" };
  const secret = process.env[envName];
  // Fail closed, and distinguishably: a missing secret is our config
  // problem, not the caller's — 503 tells the script to retry later.
  if (!secret) {
    console.error(`[invoice-intake] ${envName} is not set — rejecting request from ${caller}`);
    return { ok: false, status: 503, reason: "intake not configured" };
  }

  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, reason: "timestamp missing or outside the allowed window" };
  }
  if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, status: 401, reason: "malformed signature" };

  const expected = signIntakeRequest(secret, req.method, path, timestamp, sha256Hex(body));
  const valid = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  return valid ? { ok: true, caller } : { ok: false, status: 401, reason: "bad signature" };
}
