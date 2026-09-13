import { NextResponse } from "next/server";
import { runShipstationLabelCron } from "@/lib/shipstation-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

// Matches app/api/cron/dhl-status/route.ts's reasoning: the default 10s
// Vercel Function duration isn't enough for a full batch, and 60s is also
// the Hobby-plan ceiling, so it's set at exactly that rather than higher.
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runShipstationLabelCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/shipstation-labels] failed:", err);
    return NextResponse.json({ ok: false, error: "ShipStation label backfill failed." }, { status: 500 });
  }
}
