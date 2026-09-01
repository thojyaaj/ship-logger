import { NextResponse } from "next/server";
import { runUpsStatusCron } from "@/lib/ups-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runUpsStatusCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Same posture as the EPG cron: log the real cause, return a generic
    // message so upstream response bodies and connection details aren't
    // disclosed, and use a 5xx so a failed run is actually reported as failed.
    console.error("[cron/ups-status] failed:", err);
    return NextResponse.json({ ok: false, error: "UPS status refresh failed." }, { status: 500 });
  }
}
