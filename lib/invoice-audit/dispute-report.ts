import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine } from "../db/schema";
import { toCsv, csvPreambleLine } from "../csv";
import { getInvoiceAudit, type InvoiceAuditLineRow } from "./audit";
import { PRICE_TOLERANCE } from "./classify";

/**
 * The CSV sent *to the carrier* to dispute charges — deliberately separate
 * from the internal audit export ([id]/export/route.ts). Only parcels billed
 * above the ShipStation quote or billed twice, in the carrier's own terms
 * (invoice, AWB, EPG reference, tracking), each with a plain-English reason.
 * Nothing internal leaves: no customer payments, marketplace fee, scan ids
 * or ship_logger's own notes.
 */

const MAX_INVOICES = 100;

export type DisputeReport = { csv: string; fileName: string; parcelCount: number };

function money(n: number): string {
  return n.toFixed(2);
}

/** Where else a duplicate-billed EPG label was billed: the original line, not another duplicate. */
async function findOriginals(lines: { epgRef: string | null; id: string }[]) {
  const refs = [...new Set(lines.map((l) => l.epgRef).filter((r): r is string => !!r))];
  if (refs.length === 0) return new Map<string, { invoiceNumber: string; sheetRow: number }>();
  const rows = await db
    .select({ epgRef: invoiceAuditLine.epgRef, invoiceNumber: invoiceAudit.invoiceNumber, sheetRow: invoiceAuditLine.sheetRow })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .where(and(eq(invoiceAudit.carrier, "epg"), inArray(invoiceAuditLine.epgRef, refs), ne(invoiceAuditLine.status, "duplicate")));
  return new Map(rows.map((r) => [r.epgRef!, { invoiceNumber: r.invoiceNumber, sheetRow: r.sheetRow }]));
}

function reasonFor(l: InvoiceAuditLineRow, original: { invoiceNumber: string; sheetRow: number } | undefined): string {
  if (l.status === "duplicate") {
    return original
      ? `Billed twice: this parcel is also billed on invoice ${original.invoiceNumber} (row ${original.sheetRow})`
      : "Billed twice: this parcel appears more than once";
  }
  const parts = [`Charged ${money(l.difference ?? 0)} above the quoted rate`];
  if (l.billedHeavier && l.billedWeightLb !== null && l.quotedWeightLb !== null) {
    parts.push(`billed at ${l.billedWeightLb} lb but the label weight is ${l.quotedWeightLb.toFixed(3)} lb`);
  }
  if (l.surchargeTotal > 0) parts.push(`includes ${money(l.surchargeTotal)} in surcharges/fees`);
  return parts.join("; ");
}

export async function buildDisputeReport(auditIds: string[]): Promise<DisputeReport | null> {
  const ids = [...new Set(auditIds)].slice(0, MAX_INVOICES);
  const audits = (await Promise.all(ids.map((id) => getInvoiceAudit(id)))).filter((a) => a !== null);
  if (audits.length === 0) return null;
  audits.sort((a, b) => a.audit.invoiceNumber.localeCompare(b.audit.invoiceNumber));

  const disputed = audits.flatMap(({ audit, lines }) =>
    lines.filter((l) => l.status === "over" || l.status === "duplicate").map((line) => ({ audit, line })),
  );
  const originals = await findOriginals(disputed.filter((d) => d.line.status === "duplicate").map((d) => d.line));

  const rows = disputed.map(({ audit, line }) => {
    const disputedAmount = line.difference ?? 0;
    return [
      audit.invoiceNumber,
      line.awb ?? "",
      line.epgRef ?? "",
      line.finalMileTracking ?? "",
      line.shipDate ?? "",
      line.destinationCountry ?? "",
      line.service ?? "",
      line.billedWeightLb ?? "",
      line.quotedWeightLb !== null ? Number(line.quotedWeightLb.toFixed(3)) : "",
      line.invoicedAmount,
      // For a duplicate, nothing should have been billed on this line.
      line.status === "duplicate" ? 0 : (line.quotedAmount ?? ""),
      disputedAmount,
      line.invoicedCurrency,
      reasonFor(line, line.epgRef ? originals.get(line.epgRef) : undefined),
    ];
  });

  const total = disputed.reduce((sum, d) => sum + (d.line.difference ?? 0), 0);
  const currency = audits[0].audit.currency;
  const invoiceList = audits.map((a) => a.audit.invoiceNumber);
  const generated = new Date().toISOString().slice(0, 10);

  const preamble = [
    csvPreambleLine(["Billing discrepancy report", "OTC Shoppe Express", `Generated ${generated}`]),
    csvPreambleLine([`Invoices: ${invoiceList.join(", ")}`]),
    csvPreambleLine([
      `${disputed.length} parcel${disputed.length === 1 ? "" : "s"} disputed`,
      `Total disputed: ${money(total)} ${currency}`,
      `Differences under ${money(PRICE_TOLERANCE)} are not included`,
    ]),
  ].join("\r\n");

  const csv = `${preamble}\r\n\r\n${toCsv(
    [
      "Invoice",
      "AWB",
      "EPG Reference",
      "Tracking Number",
      "Ship Date",
      "Destination",
      "Service",
      "Billed Weight (lb)",
      "Label Weight (lb)",
      "Amount Billed",
      "Amount Expected",
      "Amount Disputed",
      "Currency",
      "Reason",
    ],
    rows,
  )}`;

  const range =
    invoiceList.length === 1 ? invoiceList[0] : `${invoiceList[0]}-to-${invoiceList[invoiceList.length - 1]}`;
  const fileName = `epg-billing-discrepancies-${range.replace(/[^0-9A-Za-z-]/g, "")}.csv`;
  return { csv, fileName, parcelCount: disputed.length };
}
