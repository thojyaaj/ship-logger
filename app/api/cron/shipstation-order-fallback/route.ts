import { NextResponse } from "next/server";
import { runShipstationOrderFallbackCron } from "@/lib/shipstation-order-fallback-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runShipstationOrderFallbackCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/shipstation-order-fallback] failed:", err);
    return NextResponse.json({ ok: false, error: "ShipStation order-fallback backfill failed." }, { status: 500 });
  }
}
