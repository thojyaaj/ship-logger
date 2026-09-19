import { NextResponse } from "next/server";
import { verifyIntakeRequest } from "@/lib/invoice-audit/intake-auth";
import { buildDisputeReport } from "@/lib/invoice-audit/dispute-report";

const PATH = "/api/v1/invoices/dispute-draft";
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Called by the Gmail Apps Script (scripts/apps-script/epg-invoice-intake.gs,
 * createDisputeDraft) to fetch the dispute report and cover email for the
 * Gmail draft it creates. POST so the requested audit ids sit in the signed
 * body — same HMAC scheme and secret as the invoice intake endpoint (see
 * lib/invoice-audit/intake-auth.ts).
 *
 * Body: { "ids": ["<auditId>", ...] }
 * 200: { subject, text, html, csv, fileName, parcelCount, totalDisputed, currency }
 */
export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });

  const auth = verifyIntakeRequest(req, PATH, body);
  if (!auth.ok) {
    console.warn(`[dispute-draft] rejected: ${auth.reason}`);
    return NextResponse.json({ error: auth.status === 503 ? "unavailable" : "unauthorized" }, { status: auth.status });
  }

  let ids: string[];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { ids?: unknown };
    ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((v): v is string => typeof v === "string" && /^[0-9a-zA-Z-]{1,64}$/.test(v))
      : [];
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (ids.length === 0) return NextResponse.json({ error: "no invoices given" }, { status: 400 });

  const report = await buildDisputeReport(ids);
  if (!report) return NextResponse.json({ error: "no matching invoices" }, { status: 404 });
  if (report.parcelCount === 0) return NextResponse.json({ error: "nothing to dispute on these invoices" }, { status: 422 });

  return NextResponse.json({
    subject: report.email.subject,
    text: report.email.text,
    html: report.email.html,
    csv: report.csv,
    fileName: report.fileName,
    parcelCount: report.parcelCount,
    totalDisputed: report.totalDisputed,
    currency: report.currency,
  });
}
