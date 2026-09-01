import { NextResponse } from "next/server";
import { runEpgStatusCron } from "@/lib/epg-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runEpgStatusCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Log the real cause for operators; return only a generic message. The
    // underlying errors embed upstream response bodies and connection strings
    // (e.g. "Shopify token exchange failed: 401 {...}", Postgres ENOTFOUND
    // <db-host>), which is infrastructure disclosure to anyone who can reach
    // this URL. Status is 500, not 200 — returning 200 on failure made Vercel
    // report a broken cron as a successful run.
    console.error("[cron/epg-status] failed:", err);
    return NextResponse.json({ ok: false, error: "EPG status refresh failed." }, { status: 500 });
  }
}
