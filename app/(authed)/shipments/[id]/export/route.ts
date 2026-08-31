import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getShipmentDetail } from "@/lib/shiplog";
import { carrierLabel } from "@/lib/carrier";
import { toCsv } from "@/lib/csv";

export async function GET(_req: Request, ctx: RouteContext<"/shipments/[id]/export">) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  let dashboard;
  try {
    dashboard = await getShipmentDetail(id);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const { session, scans, userNames } = dashboard;
  const rows = scans.map((s) => [
    s.trackingNumber,
    carrierLabel(s.carrier),
    s.boxNumber ?? "",
    userNames[s.scannedBy] ?? "",
    s.scannedAt,
    s.orderName ?? "",
    s.statusLabel ?? "",
    s.statusAt ?? "",
  ]);

  const header = [
    `Ship date: ${session.shipDate}`,
    `Status: ${session.status}`,
    `AWB: ${session.awbNumber ?? ""}`,
    `Master UPS tracking: ${session.masterUpsTracking ?? ""}`,
  ].join(" | ");

  const csv = `${header}\r\n\r\n${toCsv(
    ["Tracking Number", "Carrier", "Box", "Scanned By", "Scanned At", "Order", "Status", "Status At"],
    rows,
  )}`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shipment-${session.shipDate}-${session.id.slice(0, 8)}.csv"`,
    },
  });
}
