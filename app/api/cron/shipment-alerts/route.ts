import { NextResponse } from "next/server";
import { runShipmentAlertsCron } from "@/lib/shipment-alerts";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runShipmentAlertsCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/shipment-alerts] failed:", err);
    return NextResponse.json({ ok: false, error: "Shipment alert digest failed." }, { status: 500 });
  }
}
