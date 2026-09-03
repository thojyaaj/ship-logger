import { NextResponse } from "next/server";
import { runDhlStatusCron } from "@/lib/dhl-status-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

// DHL Unified's rate limit (1 call/5s, see lib/dhl-status-cron.ts) means a
// full batch can take up to ~50s. Vercel's default Function duration is 10s
// regardless of plan, so this needs to be raised explicitly — 60s is also
// the Hobby-plan ceiling, so it's set at exactly that rather than higher.
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runDhlStatusCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/dhl-status] failed:", err);
    return NextResponse.json({ ok: false, error: "DHL status refresh failed." }, { status: 500 });
  }
}
