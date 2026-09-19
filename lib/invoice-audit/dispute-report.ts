import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine } from "../db/schema";
import { toCsv, csvPreambleLine } from "../csv";
import { getInvoiceAudit, type InvoiceAuditLineRow } from "./audit";
import { PRICE_TOLERANCE } from "./classify";

/**
 * The report sent *to the carrier* to dispute charges — deliberately
 * separate from the internal audit export ([id]/export/route.ts). Only
 * parcels billed above the ShipStation quote or billed twice, in the
 * carrier's own terms (invoice, AWB, EPG reference, tracking), each with a
 * plain-English reason, plus a ready-to-edit cover email.
 *
 * Written for someone at EPG opening the CSV cold: a "how to read this"
 * block above the table, self-explanatory column names, and a totals row.
 * Nothing internal leaves: no customer payments, marketplace fee, scan ids
 * or ship_logger's own notes.
 */

const MAX_INVOICES = 100;
const SENDER_NAME = "OTC Shoppe Express";

type Issue = "rate" | "weight" | "surcharge" | "duplicate";

const ISSUE_LABEL: Record<Issue, string> = {
  rate: "Charged above quoted rate",
  weight: "Billed at a higher weight",
  surcharge: "Surcharge added",
  duplicate: "Billed twice",
};

type DisputedParcel = {
  invoiceNumber: string;
  line: InvoiceAuditLineRow;
  issue: Issue;
  details: string;
  expected: number;
  overcharge: number;
};

export type DisputeReport = {
  csv: string;
  fileName: string;
  parcelCount: number;
  currency: string;
  totalDisputed: number;
  email: { subject: string; text: string; html: string };
};

function money(n: number): string {
  return n.toFixed(2);
}

function usd(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${money(n)} ${currency}`;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Where else a double-billed EPG label was billed: the original line, not another duplicate. */
async function findOriginals(refs: string[]) {
  if (refs.length === 0) return new Map<string, { invoiceNumber: string; sheetRow: number }>();
  const rows = await db
    .select({ epgRef: invoiceAuditLine.epgRef, invoiceNumber: invoiceAudit.invoiceNumber, sheetRow: invoiceAuditLine.sheetRow })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .where(and(eq(invoiceAudit.carrier, "epg"), inArray(invoiceAuditLine.epgRef, refs), ne(invoiceAuditLine.status, "duplicate")));
  return new Map(rows.map((r) => [r.epgRef!, { invoiceNumber: r.invoiceNumber, sheetRow: r.sheetRow }]));
}

function describe(
  invoiceNumber: string,
  l: InvoiceAuditLineRow,
  original: { invoiceNumber: string; sheetRow: number } | undefined,
): Omit<DisputedParcel, "invoiceNumber" | "line"> {
  if (l.status === "duplicate") {
    const where = original
      ? original.invoiceNumber === invoiceNumber
        ? `row ${original.sheetRow} of this same invoice`
        : `invoice ${original.invoiceNumber} (row ${original.sheetRow})`
      : "another line";
    return {
      issue: "duplicate",
      details: `This parcel was already billed on ${where}. The full charge is disputed.`,
      expected: 0,
      overcharge: round2(l.invoicedAmount),
    };
  }

  const overcharge = round2(l.difference ?? 0);
  const expected = round2(l.quotedAmount ?? l.invoicedAmount - overcharge);
  const heavier = l.billedHeavier && l.billedWeightLb !== null && l.quotedWeightLb !== null;
  const parts = [`Charged ${money(overcharge)} more than the ${money(expected)} rate quoted when the label was purchased.`];
  if (heavier) {
    parts.push(`Billed at ${l.billedWeightLb} lb; the label weight is ${l.quotedWeightLb!.toFixed(3)} lb.`);
  }
  if (l.surchargeTotal > 0) parts.push(`Includes ${money(l.surchargeTotal)} in surcharges/fees.`);
  return {
    issue: heavier ? "weight" : l.surchargeTotal > 0 ? "surcharge" : "rate",
    details: parts.join(" "),
    expected,
    overcharge,
  };
}

export async function buildDisputeReport(auditIds: string[]): Promise<DisputeReport | null> {
  const ids = [...new Set(auditIds)].slice(0, MAX_INVOICES);
  const audits = (await Promise.all(ids.map((id) => getInvoiceAudit(id)))).filter((a) => a !== null);
  if (audits.length === 0) return null;
  audits.sort((a, b) => a.audit.invoiceNumber.localeCompare(b.audit.invoiceNumber));

  const disputedLines = audits.flatMap(({ audit, lines }) =>
    lines.filter((l) => l.status === "over" || l.status === "duplicate").map((line) => ({ audit, line })),
  );
  const originals = await findOriginals([
    ...new Set(disputedLines.filter((d) => d.line.status === "duplicate" && d.line.epgRef).map((d) => d.line.epgRef!)),
  ]);
  const parcels: DisputedParcel[] = disputedLines.map(({ audit, line }) => ({
    invoiceNumber: audit.invoiceNumber,
    line,
    ...describe(audit.invoiceNumber, line, line.epgRef ? originals.get(line.epgRef) : undefined),
  }));

  const currency = audits[0].audit.currency;
  const invoiceNumbers = audits.map((a) => a.audit.invoiceNumber);
  const totalCharged = round2(parcels.reduce((s, p) => s + p.line.invoicedAmount, 0));
  const totalExpected = round2(parcels.reduce((s, p) => s + p.expected, 0));
  const totalDisputed = round2(parcels.reduce((s, p) => s + p.overcharge, 0));
  const generated = new Date().toISOString().slice(0, 10);
  const invoiceLabel =
    invoiceNumbers.length === 1
      ? `invoice ${invoiceNumbers[0]}`
      : `invoices ${invoiceNumbers[0]} to ${invoiceNumbers[invoiceNumbers.length - 1]}`;

  const preamble = [
    csvPreambleLine([`Billing discrepancy report from ${SENDER_NAME}`, `Generated ${generated}`]),
    csvPreambleLine([
      invoiceNumbers.length === 1 ? `Covers invoice ${invoiceNumbers[0]}` : `Covers invoices ${invoiceNumbers.join(", ")}`,
    ]),
    csvPreambleLine([
      `${parcels.length} parcel${parcels.length === 1 ? "" : "s"} disputed`,
      `Charged ${money(totalCharged)} ${currency}`,
      `Expected ${money(totalExpected)} ${currency}`,
      `Total overcharge ${money(totalDisputed)} ${currency}`,
    ]),
    "",
    csvPreambleLine(["How to read this report:"]),
    csvPreambleLine([
      "Expected charge = the rate quoted for this parcel when its shipping label was purchased (what we paid for)",
    ]),
    csvPreambleLine(["EPG charged = the amount on your invoice for this parcel"]),
    csvPreambleLine(["Overcharge = EPG charged minus expected charge; for a parcel billed twice, the full second charge"]),
    csvPreambleLine([
      "Our label weight = the weight on the shipping label we purchased; EPG actual / billed weight = the weights on your invoice",
    ]),
    csvPreambleLine([`Differences under ${money(PRICE_TOLERANCE)} ${currency} are not included`]),
  ].join("\r\n");

  const rows: unknown[][] = parcels.map((p) => {
    const l = p.line;
    const weightDiff =
      l.billedWeightLb !== null && l.quotedWeightLb !== null ? round3(l.billedWeightLb - l.quotedWeightLb) : "";
    return [
      p.invoiceNumber,
      l.awb ?? "",
      l.epgRef ?? "",
      l.finalMileTracking ?? "",
      l.shipDate ?? "",
      l.destinationCountry ?? "",
      l.service ?? "",
      l.quotedWeightLb !== null ? round3(l.quotedWeightLb) : "",
      l.actualWeightLb ?? "",
      l.billedWeightLb ?? "",
      weightDiff,
      // Fixed two decimals so amounts line up for a reader; still parsed
      // as numbers by a spreadsheet.
      money(p.expected),
      money(l.invoicedAmount),
      money(p.overcharge),
      ISSUE_LABEL[p.issue],
      p.details,
    ];
  });
  rows.push(["TOTAL", "", "", "", "", "", `${parcels.length} parcels`, "", "", "", "", money(totalExpected), money(totalCharged), money(totalDisputed), "", ""]);

  const csv = `${preamble}\r\n\r\n${toCsv(
    [
      "Invoice",
      "AWB",
      "EPG Reference",
      "Tracking Number",
      "Ship Date",
      "Destination",
      "Service",
      "Our Label Weight (lb)",
      "EPG Actual Weight (lb)",
      "EPG Billed Weight (lb)",
      "Weight Difference (lb)",
      `Expected Charge (${currency})`,
      `EPG Charged (${currency})`,
      `Overcharge (${currency})`,
      "Issue",
      "Details",
    ],
    rows,
  )}`;

  const range = invoiceNumbers.length === 1 ? invoiceNumbers[0] : `${invoiceNumbers[0]}-to-${invoiceNumbers[invoiceNumbers.length - 1]}`;
  const fileName = `epg-billing-discrepancies-${range.replace(/[^0-9A-Za-z-]/g, "")}.csv`;

  return {
    csv,
    fileName,
    parcelCount: parcels.length,
    currency,
    totalDisputed,
    email: buildEmail({ parcels, audits: audits.map((a) => a.audit), invoiceLabel, currency, totalCharged, totalExpected, totalDisputed, fileName }),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The cover email for the Gmail draft — a starting point the admin reviews
 * and edits before sending, never sent automatically.
 */
function buildEmail(input: {
  parcels: DisputedParcel[];
  audits: { invoiceNumber: string; invoicedTotal: number }[];
  invoiceLabel: string;
  currency: string;
  totalCharged: number;
  totalExpected: number;
  totalDisputed: number;
  fileName: string;
}): DisputeReport["email"] {
  const { parcels, currency } = input;
  const byInvoice = input.audits
    .map((a) => {
      const own = parcels.filter((p) => p.invoiceNumber === a.invoiceNumber);
      return { invoiceNumber: a.invoiceNumber, count: own.length, amount: round2(own.reduce((s, p) => s + p.overcharge, 0)) };
    })
    .filter((i) => i.count > 0);
  const byIssue = (Object.keys(ISSUE_LABEL) as Issue[])
    .map((issue) => {
      const own = parcels.filter((p) => p.issue === issue);
      return { issue, count: own.length, amount: round2(own.reduce((s, p) => s + p.overcharge, 0)) };
    })
    .filter((i) => i.count > 0);

  const invoiceList = byInvoice.map((i) => i.invoiceNumber);
  const subject =
    invoiceList.length === 1
      ? `Billing discrepancy on invoice ${invoiceList[0]}: ${usd(input.totalDisputed, currency)} overcharged`
      : `Billing discrepancies on invoices ${invoiceList.join(", ")}: ${usd(input.totalDisputed, currency)} overcharged`;

  const plural = (n: number) => `${n} parcel${n === 1 ? "" : "s"}`;
  const intro = `We reviewed ${input.invoiceLabel} against the rates quoted for each parcel when its shipping label was purchased, and found discrepancies on ${plural(parcels.length)}. In total we were charged ${usd(input.totalCharged, currency)} for these parcels against ${usd(input.totalExpected, currency)} expected, an overcharge of ${usd(input.totalDisputed, currency)}.`;
  const ask =
    "Could you please review these charges and issue a credit for the overcharged amount? If any of them are correct, please let us know why (for example, a re-weigh or a surcharge we should expect), so we can account for it going forward.";
  const attachmentNote = `The attached CSV (${input.fileName}) lists each parcel with its AWB, EPG reference, tracking number and ship date; the weight on our shipping label next to the weight you billed; the expected charge next to the amount charged; and the reason each one is disputed. A "How to read this report" section at the top explains each column.`;

  const text = [
    "Hello ePost Global billing team,",
    "",
    intro,
    "",
    "By invoice:",
    ...byInvoice.map((i) => `- ${i.invoiceNumber}: ${plural(i.count)}, ${usd(i.amount, currency)}`),
    "",
    "By issue:",
    ...byIssue.map((i) => `- ${ISSUE_LABEL[i.issue]}: ${plural(i.count)}, ${usd(i.amount, currency)}`),
    "",
    attachmentNote,
    "",
    ask,
    "",
    "Thank you,",
    SENDER_NAME,
  ].join("\n");

  const table = (head: [string, string, string], rows: string[][]) =>
    `<table style="border-collapse:collapse;margin:4px 0 12px">
<tr>${head.map((h, i) => `<th style="text-align:${i === 0 ? "left" : "right"};padding:4px 10px;border-bottom:1px solid #ccc">${escapeHtml(h)}</th>`).join("")}</tr>
${rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i === 0 ? "left" : "right"};padding:4px 10px">${escapeHtml(c)}</td>`).join("")}</tr>`).join("\n")}
</table>`;

  const html = `<p>Hello ePost Global billing team,</p>
<p>${escapeHtml(intro)}</p>
<p><strong>By invoice</strong></p>
${table(["Invoice", "Parcels", "Overcharge"], byInvoice.map((i) => [i.invoiceNumber, String(i.count), usd(i.amount, currency)]))}
<p><strong>By issue</strong></p>
${table(["Issue", "Parcels", "Overcharge"], byIssue.map((i) => [ISSUE_LABEL[i.issue], String(i.count), usd(i.amount, currency)]))}
<p>${escapeHtml(attachmentNote)}</p>
<p>${escapeHtml(ask)}</p>
<p>Thank you,<br>${escapeHtml(SENDER_NAME)}</p>`;

  return { subject, text, html };
}
