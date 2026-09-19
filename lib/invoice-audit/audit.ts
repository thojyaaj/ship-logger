import "server-only";
import readExcelFile from "read-excel-file/node";
import { and, desc, eq, getTableColumns, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit, invoiceAuditLine, scan, shipmentSession } from "../db/schema";
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
export const MAX_LIVE_LOOKUPS = 80;

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

type ParcelIds = { epgRef: string | null; finalMileTracking: string | null };
type ScanMaps = { byTracking: Map<string, ScanQuote>; byFinalMile: Map<string, ScanQuote> };

async function findScans(lines: ParcelIds[]): Promise<ScanMaps> {
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

function matchScan(ids: ParcelIds, { byTracking, byFinalMile }: ScanMaps): ScanQuote | null {
  return (
    (ids.epgRef && byTracking.get(ids.epgRef)) ||
    (ids.finalMileTracking && (byFinalMile.get(ids.finalMileTracking) ?? byTracking.get(ids.finalMileTracking))) ||
    null
  );
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

// Written on a line whose live lookup was skipped because the audit ran out
// of lookups — recheckUnverifiedLines checks these first, since they've
// never been looked up at all.
const LOOKUP_LIMIT_NOTE = "Not checked in ShipStation yet — this audit hit its lookup limit. Use “Re-check unverified parcels”.";
// Matched instead of the full note: audits saved before the re-check
// existed carry older wording ("…hit the per-audit lookup limit.").
const LOOKUP_LIMIT_MARKER = "lookup limit";

function neverLookedUp(note: string | null): boolean {
  return note?.includes(LOOKUP_LIMIT_MARKER) ?? false;
}

export type LookupBudget = { remaining: number; used: number };

type QuoteResult = {
  quote: Quote;
  quoteSource: AuditLineRow["quoteSource"];
  notes: string[];
};

/** A scan with a saved cost — free, no API call. Null when there isn't one. */
function quoteFromScan(scanRow: ScanQuote | null): QuoteResult | null {
  if (!scanRow || scanRow.costAmount === null) return null;
  return {
    quote: { found: true, amount: scanRow.costAmount, currency: scanRow.costCurrency, weightLb: scanRow.weightLb },
    quoteSource: "scan",
    notes: [],
  };
}

/** Asks ShipStation directly, spending one lookup from `budget` (or none, if it's used up). */
async function quoteFromShipstation(key: string, scanRow: ScanQuote | null, budget: LookupBudget): Promise<QuoteResult> {
  const quote: Quote = { found: !!scanRow, amount: null, currency: null, weightLb: scanRow?.weightLb ?? null };
  if (budget.remaining <= 0) {
    // Can't claim "not found" for a parcel nobody looked for.
    return { quote: { ...quote, found: true }, quoteSource: null, notes: [LOOKUP_LIMIT_NOTE] };
  }
  if (budget.used > 0) await sleep(RATE_LIMIT_MS);
  budget.remaining--;
  budget.used++;

  const label = await lookupShipstationLabel(scanRow?.trackingNumber ?? key);
  if (label) {
    const found: Quote = { found: true, amount: label.costAmount, currency: label.costCurrency, weightLb: label.weightLb ?? quote.weightLb };
    return label.costAmount !== null
      ? { quote: found, quoteSource: "shipstation", notes: [] }
      : { quote: found, quoteSource: null, notes: ["ShipStation has this label but no cost on it (voided?)."] };
  }
  return {
    quote,
    quoteSource: null,
    notes: [scanRow ? "Scanned in ship_logger, but ShipStation returned no label cost." : "Not scanned in ship_logger and no ShipStation label found."],
  };
}

/** The verdict + quote columns of a line, from a resolved quote. Shared by a fresh audit and a re-check. */
function verdictColumns(input: {
  invoicedAmount: number;
  invoicedCurrency: string;
  billedWeightLb: number | null;
  surchargeTotal: number;
  duplicate: boolean;
  scanRow: ScanQuote | null;
  result: QuoteResult;
  leadingNotes?: string[];
}) {
  const { result } = input;
  const notes = [...(input.leadingNotes ?? []), ...result.notes];
  if (input.surchargeTotal > 0) {
    notes.push(`Includes $${input.surchargeTotal.toFixed(2)} in fuel/handling/surcharges/duty/tax.`);
  }
  const verdict = classifyLine({
    invoicedAmount: input.invoicedAmount,
    invoicedCurrency: input.invoicedCurrency,
    billedWeightLb: input.billedWeightLb,
    quote: result.quote,
    duplicate: input.duplicate,
  });
  if (verdict.billedHeavier) {
    notes.push(`Billed at ${input.billedWeightLb} lb vs ${result.quote.weightLb?.toFixed(3)} lb on the ShipStation label.`);
  }
  return {
    scanId: input.scanRow?.id ?? null,
    quoteSource: result.quoteSource,
    quotedAmount: result.quoteSource ? result.quote.amount : null,
    quotedCurrency: result.quoteSource ? result.quote.currency : null,
    quotedWeightLb: result.quote.weightLb,
    status: verdict.status,
    difference: verdict.difference,
    billedHeavier: verdict.billedHeavier,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

async function buildLines(invoiceNumber: string, lines: EpgInvoiceLine[], auditId: string): Promise<AuditLineRow[]> {
  const [scans, billedElsewhere] = await Promise.all([findScans(lines), findBilledElsewhere(invoiceNumber, lines)]);

  const seen = new Set<string>();
  const budget: LookupBudget = { remaining: MAX_LIVE_LOOKUPS, used: 0 };
  const out: AuditLineRow[] = [];

  for (const line of lines) {
    const key = line.epgRef ?? line.finalMileTracking!;
    const scanRow = matchScan(line, scans);

    const leadingNotes: string[] = [];
    let duplicate = false;
    if (seen.has(key)) {
      duplicate = true;
      leadingNotes.push("Billed more than once on this invoice.");
    } else if (line.epgRef && billedElsewhere.has(line.epgRef)) {
      duplicate = true;
      leadingNotes.push(`Already billed on invoice ${billedElsewhere.get(line.epgRef)}.`);
    }
    seen.add(key);

    // A duplicate is wrong in full whatever the quote says, so it doesn't
    // spend a live lookup.
    const result =
      quoteFromScan(scanRow) ??
      (duplicate
        ? { quote: { found: !!scanRow, amount: null, currency: null, weightLb: scanRow?.weightLb ?? null }, quoteSource: null, notes: [] }
        : await quoteFromShipstation(key, scanRow, budget));

    const surchargeTotal = line.duty + line.tax + line.fuel + line.handling + line.transportSurcharge;
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
      ...verdictColumns({
        invoicedAmount: line.total,
        invoicedCurrency: line.currency,
        billedWeightLb: line.billedWeightLb,
        surchargeTotal,
        duplicate,
        scanRow,
        result,
        leadingNotes,
      }),
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
 *   replaces the existing audit. To finish checking parcels a big invoice
 *   left unverified, use recheckUnverifiedLines instead: a re-upload
 *   starts over and hits the same lookup limit at the same place.
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
      // A re-upload replaces the audit's lines; a parcel that's already in
      // a dispute keeps its dispute record (and outcome) on the new line,
      // or the dispute would silently lose it.
      const disputed = await tx
        .select({
          sheetRow: invoiceAuditLine.sheetRow,
          epgRef: invoiceAuditLine.epgRef,
          finalMileTracking: invoiceAuditLine.finalMileTracking,
          disputeId: invoiceAuditLine.disputeId,
          disputedAmount: invoiceAuditLine.disputedAmount,
          disputeOutcome: invoiceAuditLine.disputeOutcome,
          creditedAmount: invoiceAuditLine.creditedAmount,
          disputeResolvedAt: invoiceAuditLine.disputeResolvedAt,
        })
        .from(invoiceAuditLine)
        .innerJoin(invoiceAudit, eq(invoiceAuditLine.auditId, invoiceAudit.id))
        .where(
          and(
            eq(invoiceAudit.carrier, "epg"),
            eq(invoiceAudit.invoiceNumber, invoiceNumber),
            isNotNull(invoiceAuditLine.disputeId),
          ),
        );
      const key = (l: { sheetRow: number; epgRef: string | null; finalMileTracking: string | null }) =>
        `${l.sheetRow}|${l.epgRef ?? l.finalMileTracking}`;
      const byKey = new Map(disputed.map((d) => [key(d), d]));
      for (const line of lines) {
        const d = byKey.get(key({ sheetRow: line.sheetRow, epgRef: line.epgRef ?? null, finalMileTracking: line.finalMileTracking ?? null }));
        if (!d) continue;
        line.disputeId = d.disputeId;
        line.disputedAmount = d.disputedAmount;
        line.disputeOutcome = d.disputeOutcome;
        line.creditedAmount = d.creditedAmount;
        line.disputeResolvedAt = d.disputeResolvedAt;
      }

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

export type RecheckResult = {
  /** Unverified lines this pass looked at. */
  checked: number;
  /** Of those, how many now have a quote (whatever the verdict). */
  resolved: number;
  /** Still unverified after this pass — click again to continue. */
  remaining: number;
  /** Still unverified *and* never looked up (not just "looked up, not found"). */
  neverChecked: number;
};

export const UNVERIFIED: AuditLineRow["status"][] = ["no_quote", "not_found"];

/**
 * Re-checks an audit's unverified lines (no quote / not found) in place,
 * without the original file. A fresh audit (or a re-upload) looks parcels
 * up in sheet order and stops live lookups at MAX_LIVE_LOOKUPS, so on a
 * big invoice the same tail never gets checked — this is how it does.
 *
 * Order: every unverified line first gets a free re-match against scans
 * (the labels cron may have saved a cost since), then live ShipStation
 * lookups — never-checked lines before ones already looked up and not
 * found — up to MAX_LIVE_LOOKUPS per call. Duplicates and currency
 * mismatches aren't touched: neither is waiting on a quote.
 */
export async function recheckUnverifiedLines(
  auditId: string,
  // Shared across calls by the nightly cron, so one run's lookups stay
  // capped in total rather than per audit.
  budget: LookupBudget = { remaining: MAX_LIVE_LOOKUPS, used: 0 },
): Promise<RecheckResult> {
  const [audit] = await db.select({ id: invoiceAudit.id }).from(invoiceAudit).where(eq(invoiceAudit.id, auditId)).limit(1);
  if (!audit) throw new ExpectedError("That audit no longer exists.");

  const candidates = await db
    .select()
    .from(invoiceAuditLine)
    .where(and(eq(invoiceAuditLine.auditId, auditId), inArray(invoiceAuditLine.status, UNVERIFIED)))
    .orderBy(invoiceAuditLine.sheetRow);

  candidates.sort((a, b) => Number(neverLookedUp(b.note)) - Number(neverLookedUp(a.note)));

  const scans = await findScans(candidates);
  const updates: { id: string; columns: ReturnType<typeof verdictColumns> }[] = [];

  for (const line of candidates) {
    const scanRow = matchScan(line, scans);
    let result = quoteFromScan(scanRow);
    if (!result) {
      if (budget.remaining <= 0) continue; // left exactly as it was
      result = await quoteFromShipstation(line.epgRef ?? line.finalMileTracking ?? "", scanRow, budget);
    }
    updates.push({
      id: line.id,
      columns: verdictColumns({
        invoicedAmount: line.invoicedAmount,
        invoicedCurrency: line.invoicedCurrency,
        billedWeightLb: line.billedWeightLb,
        surchargeTotal: line.surchargeTotal,
        duplicate: false,
        scanRow,
        result,
      }),
    });
  }

  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx.update(invoiceAuditLine).set(u.columns).where(eq(invoiceAuditLine.id, u.id));
    }
    const all = await tx.select().from(invoiceAuditLine).where(eq(invoiceAuditLine.auditId, auditId));
    await tx.update(invoiceAudit).set(summarize(all)).where(eq(invoiceAudit.id, auditId));
  });

  const stillUnverified = await db
    .select({ note: invoiceAuditLine.note })
    .from(invoiceAuditLine)
    .where(and(eq(invoiceAuditLine.auditId, auditId), inArray(invoiceAuditLine.status, UNVERIFIED)));

  return {
    checked: updates.length,
    resolved: updates.filter((u) => u.columns.quoteSource !== null).length,
    remaining: stillUnverified.length,
    neverChecked: stillUnverified.filter((l) => neverLookedUp(l.note)).length,
  };
}

export async function listInvoiceAudits() {
  // Newest invoice first by invoice number, not audit date — an older
  // invoice backfilled today shouldn't jump to the top (same reasoning as
  // lib/invoice-audit/analytics.ts's chart order).
  return db.select().from(invoiceAudit).orderBy(desc(invoiceAudit.invoiceNumber)).limit(200);
}

export type InvoiceAuditRow = Awaited<ReturnType<typeof listInvoiceAudits>>[number];
/**
 * A saved line plus the ship date of the parcel it matched: the shipment
 * (session) the parcel was scanned into, i.e. the day it actually left the
 * warehouse. Null for a parcel ship_logger never scanned.
 */
export type InvoiceAuditLineRow = typeof invoiceAuditLine.$inferSelect & {
  shipDate: string | null;
  sessionId: string | null;
};

/** Lines matching `where`, with each parcel's ship date (see InvoiceAuditLineRow). */
export async function loadLinesWithShipDate(where: SQL | undefined) {
  return db
    .select({
      ...getTableColumns(invoiceAuditLine),
      shipDate: shipmentSession.shipDate,
      sessionId: shipmentSession.id,
      invoiceNumber: invoiceAudit.invoiceNumber,
    })
    .from(invoiceAuditLine)
    .innerJoin(invoiceAudit, eq(invoiceAudit.id, invoiceAuditLine.auditId))
    .leftJoin(scan, eq(scan.id, invoiceAuditLine.scanId))
    .leftJoin(shipmentSession, eq(shipmentSession.id, scan.sessionId))
    .where(where)
    .orderBy(invoiceAudit.invoiceNumber, invoiceAuditLine.sheetRow);
}

export async function getInvoiceAudit(id: string): Promise<{ audit: InvoiceAuditRow; lines: InvoiceAuditLineRow[] } | null> {
  const [audit] = await db.select().from(invoiceAudit).where(eq(invoiceAudit.id, id)).limit(1);
  if (!audit) return null;
  const lines = await loadLinesWithShipDate(eq(invoiceAuditLine.auditId, id));
  return { audit, lines };
}
