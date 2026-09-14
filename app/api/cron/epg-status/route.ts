import { NextResponse } from "next/server";
import { runEpgStatusCron } from "@/lib/epg-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

// Matches dhl-status/route.ts's reasoning: Vercel's default Function
// duration is 10s, and a Hobby-plan project can't go past 60s regardless.
// findOrderByName's per-scan Shopify calls are now capped per run (see
// MAX_ORDER_LOOKUPS_PER_RUN in lib/epg-cron.ts), but the local index lookups
// and DB writes for the rest of the batch still add up — set explicitly
// rather than relying on whatever the platform default happens to be.
export const maxDuration = 60;

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
