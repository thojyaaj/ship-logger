import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getShipmentDetail, ShipmentNotFoundError } from "@/lib/shiplog";
import { carrierLabel } from "@/lib/carrier";
import { toCsv, csvPreambleLine } from "@/lib/csv";

export async function GET(_req: Request, ctx: RouteContext<"/shipments/[id]/export">) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  let dashboard;
  try {
    dashboard = await getShipmentDetail(id);
  } catch (err) {
    // As on the detail page: a missing shipment is a 404, an infrastructure
    // failure is a 500 and should be visible as one.
    if (err instanceof ShipmentNotFoundError) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw err;
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

  const header = csvPreambleLine([
    `Ship date: ${session.shipDate}`,
    `Status: ${session.status}`,
    `AWB: ${session.awbNumber ?? ""}`,
    `Master UPS tracking: ${session.masterUpsTracking ?? ""}`,
  ]);

  const csv = `${header}\r\n\r\n${toCsv(
    ["Tracking Number", "Carrier", "Box", "Scanned By", "Scanned At", "Order", "Status", "Status At"],
    rows,
  )}`;

  // shipDate is client-supplied at submit time and stored as unvalidated text,
  // so it can't be interpolated straight into a quoted header parameter —
  // a value containing a quote would break out and spoof the filename. Strip
  // to the characters a date can legitimately contain.
  const safeShipDate = String(session.shipDate).replace(/[^0-9A-Za-z-]/g, "") || "unknown";

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shipment-${safeShipDate}-${session.id.slice(0, 8)}.csv"`,
      // Stops a browser from sniffing this as HTML and rendering it inline.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
