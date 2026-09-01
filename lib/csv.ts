// Leading characters that make Excel / Sheets / LibreOffice treat a cell as a
// formula rather than text. Values in this export come from places we do not
// control — a scanned barcode, an EPG status string, a Shopify order name — so
// a cell like `=cmd|'/c calc'!A1` would execute on the machine of whoever opens
// the exported file. Prefixing with an apostrophe forces text interpretation;
// the apostrophe is consumed by the spreadsheet and not shown to the reader.
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const s = FORMULA_TRIGGERS.test(raw) ? `'${raw}` : raw;
  // \r must be quoted alongside \n: a bare carriage return inside an unquoted
  // cell splits the row in most parsers, corrupting every column after it.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

/**
 * A single free-text line for the preamble above the table. Callers were
 * hand-joining these with `|`, which meant an AWB or ship date containing a
 * quote or comma corrupted the file — the preamble bypassed csvCell entirely.
 */
export function csvPreambleLine(parts: string[]): string {
  return csvCell(parts.join(" | "));
}
