import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getInvoiceAudit } from "@/lib/invoice-audit/audit";
import { STATUS_LABEL } from "@/lib/invoice-audit/format";
import { toCsv, csvPreambleLine } from "@/lib/csv";

export async function GET(_req: Request, ctx: RouteContext<"/admin/invoice-audits/[id]/export">) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (!user.isAdmin) return new NextResponse("Forbidden", { status: 403 });

  const { id } = await ctx.params;
  const result = await getInvoiceAudit(id);
  if (!result) return new NextResponse("Not found", { status: 404 });
  const { audit, lines } = result;

  const rows = lines.map((l) => [
    l.sheetRow,
    l.awb ?? "",
    l.epgRef ?? "",
    l.finalMileTracking ?? "",
    l.destinationCountry ?? "",
    STATUS_LABEL[l.status],
    l.invoicedAmount,
    l.surchargeTotal,
    l.quotedAmount ?? "",
    l.quoteSource ?? "",
    l.difference ?? "",
    l.billedWeightLb ?? "",
    l.quotedWeightLb ?? "",
    l.billedHeavier ? "yes" : "",
    l.note ?? "",
  ]);

  const csv = `${csvPreambleLine([
    `${audit.carrier.toUpperCase()} invoice ${audit.invoiceNumber}`,
    `Audited ${audit.createdAt} UTC`,
    `Invoiced ${audit.invoicedTotal} ${audit.currency}`,
    `Overcharged ${audit.overchargeTotal} ${audit.currency}`,
  ])}\r\n\r\n${toCsv(
    [
      "Sheet Row",
      "AWB",
      "EPG Ref",
      "Final-Mile Tracking",
      "Country",
      "Status",
      "Billed",
      "Surcharges",
      "Quoted",
      "Quote Source",
      "Difference",
      "Billed Weight (lb)",
      "Label Weight (lb)",
      "Billed Heavier",
      "Notes",
    ],
    rows,
  )}`;

  // Invoice numbers are parsed from an external file — strip to safe filename characters.
  const safeInvoice = audit.invoiceNumber.replace(/[^0-9A-Za-z-]/g, "") || "invoice";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoice-audit-${safeInvoice}.csv"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
