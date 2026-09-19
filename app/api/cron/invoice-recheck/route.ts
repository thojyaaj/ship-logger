import { NextResponse } from "next/server";
import { runInvoiceRecheckCron } from "@/lib/invoice-audit/recheck-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runInvoiceRecheckCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/invoice-recheck] failed:", err);
    return NextResponse.json({ ok: false, error: "Invoice audit re-check failed." }, { status: 500 });
  }
}
