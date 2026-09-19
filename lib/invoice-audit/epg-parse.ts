import { ExpectedError } from "../expected-error";
import { normalizeTrackingNumber } from "../carrier";

/**
 * Parses ePost Global's "AWB Package Detail for Invoice" spreadsheet — the
 * .xlsx EPG emails with every invoice — into one line per billed parcel.
 * Pure (no DB, no I/O) so the upload action and the Gmail intake endpoint
 * both run the exact same parse.
 *
 * The sheet isn't one table: it's a title row ("AWB Package Detail for
 * Invoice OTCBIX210"), then one block per AWB, each with its own header row
 * (first cell is the AWB itself, e.g. "AWB7637529") and a trailing
 * "Total Pieces" summary row. Columns are located by header name within
 * each block rather than by fixed index, so EPG reordering or adding a
 * column doesn't silently shift every figure by one.
 *
 * Units, verified against the sample invoice rather than assumed: weights
 * are pounds and dimensions are inches — `dim_wt` is exactly
 * L × W × H / 166, the imperial dimensional-weight divisor — so billed
 * weight compares directly against ShipStation's pound weights.
 *
 * Two identifiers per parcel, and they are NOT interchangeable:
 * - `refno` is EPG's own label number ("EPG030976226576793") — what the
 *   warehouse scans, so it's `scan.trackingNumber` in this app.
 * - `trackingno` is the final-mile carrier's number (Australia Post, Royal
 *   Mail…) — `scan.epgFinalMile`, once the EPG status cron has resolved it.
 */

export type EpgInvoiceLine = {
  /** 1-based row in the sheet, so an admin can find the line in the original file. */
  sheetRow: number;
  awb: string | null;
  service: string | null;
  epgRef: string | null;
  finalMileTracking: string | null;
  destinationCountry: string | null;
  actualWeightLb: number | null;
  dimWeightLb: number | null;
  billedWeightLb: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  sellRate: number;
  duty: number;
  tax: number;
  fuel: number;
  handling: number;
  transportSurcharge: number;
  total: number;
  currency: string;
};

export type EpgInvoice = {
  invoiceNumber: string;
  lines: EpgInvoiceLine[];
};

type Cell = string | number | boolean | Date | null | undefined;
export type SheetRows = Cell[][];

const TITLE_PATTERN = /Invoice\s+([A-Z0-9-]+)/i;

// Header name (lowercased, trimmed) → field. The sheet repeats "Country"
// (full name, then again after `ctycode`); only the first is used.
const COLUMNS = {
  service: "service1",
  finalMileTracking: "trackingno",
  actualWeightLb: "act_wt",
  dimWeightLb: "dim_wt",
  lengthIn: "dim_length",
  widthIn: "dim_width",
  heightIn: "dim_height",
  billedWeightLb: "bill_wt",
  sellRate: "sell_rate",
  duty: "duty",
  tax: "tax",
  fuel: "fuel",
  handling: "handling",
  transportSurcharge: "transportation surcharge",
  total: "total_amt",
  currency: "currency",
  destinationCountry: "country",
  epgRef: "refno",
} as const;

type ColumnKey = keyof typeof COLUMNS;
type ColumnIndex = Partial<Record<ColumnKey, number>>;

// A block isn't usable without these — anything else missing just reads as null/0.
const REQUIRED: ColumnKey[] = ["finalMileTracking", "total", "epgRef"];

function text(cell: Cell): string | null {
  if (cell === null || cell === undefined) return null;
  const s = String(cell).trim();
  return s === "" ? null : s;
}

/** EPG writes some numbers as numbers and some as text ("8.25") — accept both. */
function num(cell: Cell): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  const s = text(cell);
  if (s === null) return null;
  const n = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function headerIndex(row: Cell[]): ColumnIndex | null {
  const names = row.map((c) => text(c)?.toLowerCase() ?? null);
  if (!names.includes(COLUMNS.finalMileTracking)) return null;
  const index: ColumnIndex = {};
  for (const [key, name] of Object.entries(COLUMNS) as [ColumnKey, string][]) {
    const i = names.indexOf(name);
    if (i !== -1) index[key] = i;
  }
  return index;
}

export function parseEpgInvoice(rows: SheetRows): EpgInvoice {
  let invoiceNumber: string | null = null;
  let columns: ColumnIndex | null = null;
  let awb: string | null = null;
  const lines: EpgInvoiceLine[] = [];

  rows.forEach((row, i) => {
    const first = text(row[0]);

    if (!invoiceNumber && first) {
      const title = TITLE_PATTERN.exec(first);
      if (title) {
        invoiceNumber = title[1].toUpperCase();
        return;
      }
    }

    const header = headerIndex(row);
    if (header) {
      const missing = REQUIRED.filter((k) => header[k] === undefined);
      if (missing.length > 0) {
        throw new ExpectedError(
          `Row ${i + 1} looks like an EPG header but is missing ${missing.map((k) => COLUMNS[k]).join(", ")}.`,
        );
      }
      columns = header;
      awb = first;
      return;
    }

    if (!columns) return;
    const c = columns as ColumnIndex;
    const at = (key: ColumnKey): Cell => (c[key] === undefined ? null : row[c[key]!]);

    const finalMile = text(at("finalMileTracking"));
    const epgRef = text(at("epgRef"));
    const total = num(at("total"));
    // Blank separators and "Total Pieces" rows carry no tracking/ref.
    if ((!finalMile && !epgRef) || total === null) return;

    lines.push({
      sheetRow: i + 1,
      awb,
      service: text(at("service")),
      epgRef: epgRef ? normalizeTrackingNumber(epgRef) : null,
      finalMileTracking: finalMile ? normalizeTrackingNumber(finalMile) : null,
      destinationCountry: text(at("destinationCountry")),
      actualWeightLb: num(at("actualWeightLb")),
      dimWeightLb: num(at("dimWeightLb")),
      billedWeightLb: num(at("billedWeightLb")),
      lengthIn: num(at("lengthIn")),
      widthIn: num(at("widthIn")),
      heightIn: num(at("heightIn")),
      sellRate: num(at("sellRate")) ?? 0,
      duty: num(at("duty")) ?? 0,
      tax: num(at("tax")) ?? 0,
      fuel: num(at("fuel")) ?? 0,
      handling: num(at("handling")) ?? 0,
      transportSurcharge: num(at("transportSurcharge")) ?? 0,
      total,
      currency: text(at("currency"))?.toUpperCase() ?? "USD",
    });
  });

  if (!invoiceNumber) {
    throw new ExpectedError(
      'Couldn\'t find the invoice number — expected a title row like "AWB Package Detail for Invoice OTCBIX210". Is this an EPG package-detail invoice?',
    );
  }
  if (lines.length === 0) {
    throw new ExpectedError(`Invoice ${invoiceNumber} has no parcel rows this parser recognizes.`);
  }
  return { invoiceNumber, lines };
}
