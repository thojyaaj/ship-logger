import { NextResponse } from "next/server";
import { runShipstationDeliveryCron } from "@/lib/shipstation-delivery-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runShipstationDeliveryCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/shipstation-delivery] failed:", err);
    return NextResponse.json({ ok: false, error: "ShipStation delivery-estimate backfill failed." }, { status: 500 });
  }
}
