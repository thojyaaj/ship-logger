import "server-only";
import readExcelFile from "read-excel-file/node";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine, scan } from "../db/schema";
import { newId } from "../id";
import { ExpectedError } from "../expected-error";
import { lookupShipstationLabel } from "../shipstation";
import { sendAlertEmail } from "../email";
import { parseEpgInvoice, type EpgInvoiceLine, type SheetRows } from "./epg-parse";
import { classifyLine, type Quote } from "./classify";

/**
 * Carrier invoice audit: for every parcel on a carrier's invoice, compare
 * what the carrier billed against what ShipStation quoted when the label
 * was bought.
 *
 * Where the quote comes from, in order:
 * 1. The scan's own `shipstationCostAmount` (backfilled nightly by the
 *    shipstation-labels cron) — free, no API call.
 * 2. A live ShipStation label lookup, for parcels ship_logger never
 *    scanned or hasn't backfilled yet — capped per audit (see
 *    MAX_LIVE_LOOKUPS) to stay inside Vercel's 60s function limit.
 *
 * Read-only toward `scan`: a live lookup's result is recorded on the audit
 * line, not written back — the labels cron stays the one writer of scan
 * cost columns.
 */

export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;

// Same pacing as lib/shipstation-cron.ts (ShipStation v2 allows 200/min).
// 80 × 350ms ≈ 28s, leaving room for parsing and DB round-trips.
const RATE_LIMIT_MS = 350;
const MAX_LIVE_LOOKUPS = 80;

const APP_URL = "https://ship.otcshoppeexpress.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readWorkbookRows(bytes: Uint8Array): Promise<SheetRows> {
  if (bytes.byteLength > MAX_INVOICE_BYTES) {
    throw new ExpectedError("That file is over 10 MB — too large for an invoice spreadsheet.");
  }
  try {
    const sheets = await readExcelFile(Buffer.from(bytes));
    return sheets.flatMap((s) => s.data as SheetRows);
  } catch {
    throw new ExpectedError("Couldn't read that file as an Excel workbook. Upload the .xlsx exactly as EPG sent it.");
  }
}

type ScanQuote = {
  id: string;
  trackingNumber: string;
  epgFinalMile: string | null;
  costAmount: number | null;
  costCurrency: string | null;
  weightLb: number | null;
};

async function findScans(lines: EpgInvoiceLine[]): Promise<{ byTracking: Map<string, ScanQuote>; byFinalMile: Map<string, ScanQuote> }> {
  const refs = [...new Set(lines.flatMap((l) => [l.epgRef, l.finalMileTracking]).filter((v): v is string => !!v))];
  const byTracking = new Map<string, ScanQuote>();
  const byFinalMile = new Map<string, ScanQuote>();
  if (refs.length === 0) return { byTracking, byFinalMile };

  const rows = await db
    .select({
      id: scan.id,
      trackingNumber: scan.trackingNumber,
      epgFinalMile: scan.epgFinalMile,
      costAmount: scan.shipstationCostAmount,
      costCurrency: scan.shipstationCostCurrency,
      weightLb: scan.shipstationWeightLb,
    })
    .from(scan)
    // trackingNumber is stored already normalized (uppercase — see
    // normalizeTrackingNumber), so it can use its unique index directly;
    // epgFinalMile comes back from EPG as-is, hence upper() there.
    .where(or(inArray(scan.trackingNumber, refs), inArray(sql`upper(${scan.epgFinalMile})`, refs)));

  for (const r of rows) {
    byTracking.set(r.trackingNumber.toUpperCase(), r);
    if (r.epgFinalMile) byFinalMile.set(r.epgFinalMile.toUpperCase(), r);
  }
  return { byTracking, byFinalMile };
}

/** EPG labels already billed on a *different* invoice — a parcel shouldn't be billed twice. */
async function findBilledElsewhere(invoiceNumber: string, lines: EpgInvoiceLine[]): Promise<Map<string, string>> {
  const refs = [...new Set(lines.map((l) => l.epgRef).filter((v): v is string => !!v))];
  if (refs.length === 0) return new Map();
  const rows = await db
    .select({ epgRef: invoiceAuditLine.epgRef, invoiceNumber: invoiceAudit.invoiceNumber })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
    .where(
      and(
        eq(invoiceAudit.carrier, "epg"),
        ne(invoiceAudit.invoiceNumber, invoiceNumber),
        inArray(invoiceAuditLine.epgRef, refs),
        // A parcel that was itself flagged as the duplicate on that other
        // invoice doesn't make this billing a duplicate of it.
        ne(invoiceAuditLine.status, "duplicate"),
      ),
    );
  return new Map(rows.map((r) => [r.epgRef!, r.invoiceNumber]));
}

type AuditLineRow = typeof invoiceAuditLine.$inferInsert;

async function buildLines(invoiceNumber: string, lines: EpgInvoiceLine[], auditId: string): Promise<AuditLineRow[]> {
  const [{ byTracking, byFinalMile }, billedElsewhere] = await Promise.all([
    findScans(lines),
    findBilledElsewhere(invoiceNumber, lines),
  ]);

  const seen = new Set<string>();
  let liveLookups = 0;
  const out: AuditLineRow[] = [];

  for (const line of lines) {
    const key = line.epgRef ?? line.finalMileTracking!;
    const scanRow =
      (line.epgRef && byTracking.get(line.epgRef)) ||
      (line.finalMileTracking && (byFinalMile.get(line.finalMileTracking) ?? byTracking.get(line.finalMileTracking))) ||
      null;

    const notes: string[] = [];
    let duplicate = false;
    if (seen.has(key)) {
      duplicate = true;
      notes.push("Billed more than once on this invoice.");
    } else if (line.epgRef && billedElsewhere.has(line.epgRef)) {
      duplicate = true;
      notes.push(`Already billed on invoice ${billedElsewhere.get(line.epgRef)}.`);
    }
    seen.add(key);

    let quote: Quote = { found: !!scanRow, amount: null, currency: null, weightLb: scanRow?.weightLb ?? null };
    let quoteSource: AuditLineRow["quoteSource"] = null;

    if (scanRow && scanRow.costAmount !== null) {
      quote = { found: true, amount: scanRow.costAmount, currency: scanRow.costCurrency, weightLb: scanRow.weightLb };
      quoteSource = "scan";
    } else if (!duplicate) {
      if (liveLookups < MAX_LIVE_LOOKUPS) {
        if (liveLookups > 0) await sleep(RATE_LIMIT_MS);
        liveLookups++;
        const label = await lookupShipstationLabel(scanRow?.trackingNumber ?? key);
        if (label) {
          quote = { found: true, amount: label.costAmount, currency: label.costCurrency, weightLb: label.weightLb ?? quote.weightLb };
          if (label.costAmount !== null) quoteSource = "shipstation";
          else notes.push("ShipStation has this label but no cost on it (voided?).");
        } else if (scanRow) {
          notes.push("Scanned in ship_logger, but ShipStation returned no label cost.");
        } else {
          notes.push("Not scanned in ship_logger and no ShipStation label found.");
        }
      } else {
        // Can't claim "not found" for a parcel nobody looked for.
        quote = { ...quote, found: true };
        notes.push("Not checked in ShipStation — this invoice hit the per-audit lookup limit.");
      }
    }

    const surchargeTotal = line.duty + line.tax + line.fuel + line.handling + line.transportSurcharge;
    if (surchargeTotal > 0) notes.push(`Includes $${surchargeTotal.toFixed(2)} in fuel/handling/surcharges/duty/tax.`);

    const verdict = classifyLine({
      invoicedAmount: line.total,
      invoicedCurrency: line.currency,
      billedWeightLb: line.billedWeightLb,
      quote,
      duplicate,
    });
    if (verdict.billedHeavier) {
      notes.push(`Billed at ${line.billedWeightLb} lb vs ${quote.weightLb?.toFixed(3)} lb on the ShipStation label.`);
    }

    out.push({
      id: newId(),
      auditId,
      sheetRow: line.sheetRow,
      awb: line.awb,
      service: line.service,
      epgRef: line.epgRef,
      finalMileTracking: line.finalMileTracking,
      destinationCountry: line.destinationCountry,
      actualWeightLb: line.actualWeightLb,
      dimWeightLb: line.dimWeightLb,
      billedWeightLb: line.billedWeightLb,
      sellRate: line.sellRate,
      surchargeTotal,
      invoicedAmount: line.total,
      invoicedCurrency: line.currency,
      scanId: scanRow?.id ?? null,
      quoteSource,
      quotedAmount: quoteSource ? quote.amount : null,
      quotedCurrency: quoteSource ? quote.currency : null,
      quotedWeightLb: quote.weightLb,
      status: verdict.status,
      difference: verdict.difference,
      billedHeavier: verdict.billedHeavier,
      note: notes.length > 0 ? notes.join(" ") : null,
    });
  }
  return out;
}

function summarize(lines: AuditLineRow[]) {
  const count = (s: AuditLineRow["status"]) => lines.filter((l) => l.status === s).length;
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  return {
    currency: lines[0]?.invoicedCurrency ?? "USD",
    lineCount: lines.length,
    invoicedTotal: sum(lines.map((l) => l.invoicedAmount)),
    quotedTotal: sum(lines.map((l) => l.quotedAmount ?? 0)),
    overchargeTotal: sum(lines.filter((l) => l.status === "over" || l.status === "duplicate").map((l) => l.difference ?? 0)),
    underchargeTotal: sum(lines.filter((l) => l.status === "under").map((l) => -(l.difference ?? 0))),
    overCount: count("over"),
    underCount: count("under"),
    matchCount: count("match"),
    noQuoteCount: count("no_quote") + count("currency_mismatch"),
    notFoundCount: count("not_found"),
    duplicateCount: count("duplicate"),
  };
}

export type AuditSummary = ReturnType<typeof summarize>;

export type AuditOutcome = {
  outcome: "created" | "replaced" | "duplicate";
  auditId: string;
  invoiceNumber: string;
};

/**
 * Runs and saves an EPG invoice audit.
 *
 * - `source: "email"` (the Gmail intake) is idempotent on invoice number:
 *   an invoice that's already been audited is a no-op `duplicate`, since
 *   re-delivery of the same email is expected, not an error.
 * - `source: "upload"` is an explicit admin action, so it re-runs and
 *   replaces the existing audit — the way to pick up costs the labels cron
 *   has backfilled since the first run.
 */
export async function auditEpgInvoice(input: {
  bytes: Uint8Array;
  fileName: string | null;
  source: "upload" | "email";
  createdBy: string | null;
  emailMessageId?: string | null;
}): Promise<AuditOutcome> {
  const invoice = parseEpgInvoice(await readWorkbookRows(input.bytes));
  const { invoiceNumber } = invoice;

  const existing = await db
    .select({ id: invoiceAudit.id })
    .from(invoiceAudit)
    .where(and(eq(invoiceAudit.carrier, "epg"), eq(invoiceAudit.invoiceNumber, invoiceNumber)))
    .limit(1);
  if (existing[0] && input.source === "email") {
    return { outcome: "duplicate", auditId: existing[0].id, invoiceNumber };
  }

  const auditId = newId();
  const lines = await buildLines(invoiceNumber, invoice.lines, auditId);
  const summary = summarize(lines);

  const inserted = await db.transaction(async (tx) => {
    if (input.source === "upload") {
      await tx
        .delete(invoiceAudit)
        .where(and(eq(invoiceAudit.carrier, "epg"), eq(invoiceAudit.invoiceNumber, invoiceNumber)));
    }
    const rows = await tx
      .insert(invoiceAudit)
      .values({
        id: auditId,
        carrier: "epg",
        invoiceNumber,
        fileName: input.fileName,
        source: input.source,
        emailMessageId: input.emailMessageId ?? null,
        createdBy: input.createdBy,
        ...summary,
      })
      .onConflictDoNothing()
      .returning({ id: invoiceAudit.id });
    if (rows.length === 0) return false;
    for (let i = 0; i < lines.length; i += 1000) {
      await tx.insert(invoiceAuditLine).values(lines.slice(i, i + 1000));
    }
    return true;
  });

  if (!inserted) {
    // Lost a race with a concurrent audit of the same invoice (two emails
    // processed at once, or an upload landing mid-intake).
    const [winner] = await db
      .select({ id: invoiceAudit.id })
      .from(invoiceAudit)
      .where(and(eq(invoiceAudit.carrier, "epg"), eq(invoiceAudit.invoiceNumber, invoiceNumber)))
      .limit(1);
    if (!winner) throw new Error(`Invoice ${invoiceNumber} audit conflicted but no existing row was found.`);
    return { outcome: "duplicate", auditId: winner.id, invoiceNumber };
  }

  if (input.source === "email") {
    await sendAuditEmail(auditId, invoiceNumber, summary);
  }
  return { outcome: existing[0] ? "replaced" : "created", auditId, invoiceNumber };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

async function sendAuditEmail(auditId: string, invoiceNumber: string, s: AuditSummary): Promise<void> {
  const flagged = s.overCount + s.duplicateCount;
  const subject =
    flagged > 0
      ? `EPG invoice ${invoiceNumber}: ${flagged} parcel${flagged === 1 ? "" : "s"} overcharged (+${money(s.overchargeTotal, s.currency)})`
      : `EPG invoice ${invoiceNumber} audited — no overcharges found`;
  const rows: [string, string][] = [
    ["Parcels on invoice", String(s.lineCount)],
    ["Invoiced total", money(s.invoicedTotal, s.currency)],
    ["Overcharged", `${s.overCount} (+${money(s.overchargeTotal, s.currency)} incl. duplicates)`],
    ["Billed twice", String(s.duplicateCount)],
    ["Undercharged", `${s.underCount} (−${money(s.underchargeTotal, s.currency)})`],
    ["Matched quote", String(s.matchCount)],
    ["No ShipStation quote", String(s.noQuoteCount)],
    ["Not found anywhere", String(s.notFoundCount)],
  ];
  const html = `<p>ship_logger audited EPG invoice <strong>${escapeHtml(invoiceNumber)}</strong> from Gmail.</p>
<table style="border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 8px">${escapeHtml(k)}</td><td style="padding:4px 8px;font-family:monospace">${escapeHtml(v)}</td></tr>`)
    .join("")}</table>
<p><a href="${APP_URL}/admin/invoice-audits/${encodeURIComponent(auditId)}">Open the full audit</a></p>`;
  await sendAlertEmail(subject, html);
}

export async function listInvoiceAudits() {
  return db.select().from(invoiceAudit).orderBy(desc(invoiceAudit.createdAt)).limit(200);
}

export type InvoiceAuditRow = Awaited<ReturnType<typeof listInvoiceAudits>>[number];
export type InvoiceAuditLineRow = typeof invoiceAuditLine.$inferSelect;

export async function getInvoiceAudit(id: string): Promise<{ audit: InvoiceAuditRow; lines: InvoiceAuditLineRow[] } | null> {
  const [audit] = await db.select().from(invoiceAudit).where(eq(invoiceAudit.id, id)).limit(1);
  if (!audit) return null;
  const lines = await db
    .select()
    .from(invoiceAuditLine)
    .where(eq(invoiceAuditLine.auditId, id))
    .orderBy(invoiceAuditLine.sheetRow);
  return { audit, lines };
}
