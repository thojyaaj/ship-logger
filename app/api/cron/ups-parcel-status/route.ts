import { NextResponse } from "next/server";
import { runUpsParcelStatusCron } from "@/lib/ups-parcel-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

// No mandatory inter-call delay (see lib/ups-parcel-cron.ts), but a batch of
// up to 40 sequential live lookups can still run past Vercel's default 10s
// Function duration — raised the same way as the DHL cron's route.
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runUpsParcelStatusCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Same posture as the other status crons: log the real cause, return a
    // generic message so upstream response bodies and connection details
    // aren't disclosed, and use a 5xx so a failed run is actually reported
    // as failed.
    console.error("[cron/ups-parcel-status] failed:", err);
    return NextResponse.json({ ok: false, error: "UPS parcel status refresh failed." }, { status: 500 });
  }
}
