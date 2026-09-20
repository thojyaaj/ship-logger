import { NextResponse } from "next/server";
import { enrichInvoiceLines } from "@/lib/invoice-audit/enrich";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    // Every audit, newest invoice first, sharing one run's budget — see
    // lib/invoice-audit/enrich.ts. Its own route (not tacked onto
    // invoice-recheck) so each gets a full 60s function.
    const result = await enrichInvoiceLines({});
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/invoice-enrich] failed:", err);
    return NextResponse.json({ ok: false, error: "Invoice ship-date/charge lookup failed." }, { status: 500 });
  }
}
