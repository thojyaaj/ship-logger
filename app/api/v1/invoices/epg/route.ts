import { NextResponse } from "next/server";
import { verifyIntakeRequest } from "@/lib/invoice-audit/intake-auth";
import { auditEpgInvoice, MAX_INVOICE_BYTES } from "@/lib/invoice-audit/audit";
import { ExpectedError } from "@/lib/expected-error";

// Live ShipStation lookups for unscanned parcels can take ~30s — see
// MAX_LIVE_LOOKUPS in lib/invoice-audit/audit.ts.
export const maxDuration = 60;

const PATH = "/api/v1/invoices/epg";

/**
 * Gmail intake for EPG invoices: scripts/apps-script/epg-invoice-intake.gs
 * posts each invoice .xlsx attachment here as the raw request body,
 * HMAC-signed (see lib/invoice-audit/intake-auth.ts).
 *
 * Responses the script acts on:
 * - 200 `created` / `duplicate` — done; the script labels the email so it
 *   isn't sent again. A duplicate (already-audited invoice) is a success,
 *   since re-delivery is expected.
 * - 422 — the file isn't an EPG invoice this parser understands. Also
 *   final: the script labels it separately so it isn't retried forever.
 * - anything else — transient; the script leaves the email and retries on
 *   its next run.
 */
export async function POST(req: Request) {
  // Checked before reading the body, so an oversized upload is refused
  // without buffering it. Content-Length can lie, so the buffered size is
  // checked again below.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_INVOICE_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_INVOICE_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  const auth = verifyIntakeRequest(req, PATH, body);
  if (!auth.ok) {
    console.warn(`[invoice-intake] rejected: ${auth.reason}`);
    // Generic body: the specific reason is for our logs, not the caller.
    return NextResponse.json({ error: auth.status === 503 ? "unavailable" : "unauthorized" }, { status: auth.status });
  }
  if (body.byteLength === 0) return NextResponse.json({ error: "empty body" }, { status: 400 });

  const fileName = (req.headers.get("x-shiplogger-filename") ?? "").slice(0, 200) || null;
  const emailMessageId = (req.headers.get("x-shiplogger-message-id") ?? "").slice(0, 200) || null;

  try {
    const result = await auditEpgInvoice({ bytes: body, fileName, source: "email", createdBy: null, emailMessageId });
    return NextResponse.json({ status: result.outcome, invoiceNumber: result.invoiceNumber, auditId: result.auditId });
  } catch (err) {
    if (err instanceof ExpectedError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
