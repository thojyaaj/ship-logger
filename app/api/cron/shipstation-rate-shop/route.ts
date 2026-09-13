import { NextResponse } from "next/server";
import { runShipstationRateShopCron } from "@/lib/shipstation-rate-shop-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runShipstationRateShopCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/shipstation-rate-shop] failed:", err);
    return NextResponse.json({ ok: false, error: "ShipStation rate-shop backfill failed." }, { status: 500 });
  }
}
