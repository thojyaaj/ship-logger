import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseEpgInvoice, type SheetRows } from "./epg-parse";
import { ExpectedError } from "../expected-error";

/**
 * The parser's input is the sheet as rows of cells. The fixtures below copy
 * the real EPG "AWB Package Detail" layout — a title row, then per AWB a
 * header row (first cell is the AWB), parcel rows, and a "Total Pieces"
 * summary row — using invented parcels.
 */

// The real header, including its quirks: an unnamed column, and "Country"
// twice (the full name, then again after ctycode).
const HEADER = [
  "service1", "trackingno", "act_wt", "dim_wt", "wt_diff", "dim_length", "dim_width", "dim_height", "bill_wt",
  "sell_rate", "duty", "tax", "Fuel", "Handling", "Transportation Surcharge", null, "total_amt", "CURRENCY",
  "pkg_value", "custno", "Country", "refno", "NAME", "address1", "address2", "address3", "city", "state", "zip",
  "phone", "email", "ctycode", "Country", "from_datafile", "CA_exchange_rate", "UK_exchange_rate", "prod_code",
];

const title = (invoice = "OTCBIX999"): SheetRows[number] => [`AWB Package Detail for Invoice ${invoice}`, ...Array(37).fill(null)];
const header = (awb: string, columns: (string | null)[] = HEADER): SheetRows[number] => [awb, ...columns];

/** A parcel row keyed by header name (first match wins, like the parser). */
function parcel(values: Record<string, unknown>, columns: (string | null)[] = HEADER): SheetRows[number] {
  const defaults: Record<string, unknown> = {
    service1: "Priority Packet Tracked", trackingno: "LX000000001NL", act_wt: 0.5, dim_wt: 0.8, bill_wt: 0.5,
    sell_rate: 10, duty: 0, tax: 0, Fuel: 0, Handling: 0, "Transportation Surcharge": 0, total_amt: 10,
    CURRENCY: "USD", refno: "EPG000000000000001", Country: "AUSTRALIA",
  };
  const merged = { ...defaults, ...values };
  return ["www.epgtrack.com", ...columns.map((name) => (name === null ? null : (merged[name] ?? null)))];
}

const summary = (total: number): SheetRows[number] => ["Total Pieces", 2, ...Array(37).fill(null)].map((v, i) => (i === 17 ? total : v));

describe("parseEpgInvoice", () => {
  test("reads the invoice number from the title row, uppercased", () => {
    const inv = parseEpgInvoice([title("otcbix210"), header("AWB1"), parcel({})]);
    assert.equal(inv.invoiceNumber, "OTCBIX210");
  });

  test("reads a parcel: numbers, text-typed numbers, refs and currency normalized", () => {
    const [line] = parseEpgInvoice([
      title(),
      header("AWB7637529"),
      parcel({
        refno: "  epg030976226576793 ",
        trackingno: "lx048 889 563nl",
        act_wt: 0.183, dim_wt: 0.919, bill_wt: 0.183,
        dim_length: "8.25", dim_width: "5.30", dim_height: "3.49", // EPG writes dimensions as text
        sell_rate: 9.73, total_amt: 9.73, CURRENCY: "usd",
      }),
    ]).lines;
    assert.equal(line.epgRef, "EPG030976226576793");
    assert.equal(line.finalMileTracking, "LX048889563NL");
    assert.equal(line.awb, "AWB7637529");
    assert.equal(line.service, "Priority Packet Tracked");
    assert.equal(line.actualWeightLb, 0.183);
    assert.equal(line.dimWeightLb, 0.919);
    assert.equal(line.billedWeightLb, 0.183);
    assert.deepEqual([line.lengthIn, line.widthIn, line.heightIn], [8.25, 5.3, 3.49]);
    assert.equal(line.sellRate, 9.73);
    assert.equal(line.total, 9.73);
    assert.equal(line.currency, "USD");
  });

  test("uses the first 'Country' column (the full name), not the code column's neighbor", () => {
    const columns = [...HEADER];
    const [line] = parseEpgInvoice([
      title(), header("A", columns),
      // second "Country" column (index of the last one) holds a different value
      (() => { const r = parcel({ Country: "GREAT BRITAIN" }, columns); r[columns.lastIndexOf("Country") + 1] = "IGNORED"; return r; })(),
    ]).lines;
    assert.equal(line.destinationCountry, "GREAT BRITAIN");
  });

  test("reads surcharges, duties and taxes", () => {
    const [line] = parseEpgInvoice([
      title(), header("A"),
      parcel({ duty: 1.5, tax: 0.25, Fuel: 0.75, Handling: 2, "Transportation Surcharge": 3, sell_rate: 10, total_amt: 17.5 }),
    ]).lines;
    assert.deepEqual([line.duty, line.tax, line.fuel, line.handling, line.transportSurcharge], [1.5, 0.25, 0.75, 2, 3]);
    assert.equal(line.total, 17.5);
  });

  test("handles several AWB blocks, tagging each parcel with its AWB and its 1-based sheet row", () => {
    const rows: SheetRows = [
      title(),                                  // row 1
      header("AWB100"),                         // row 2
      parcel({ refno: "EPG000000000000001" }),  // row 3
      parcel({ refno: "EPG000000000000002" }),  // row 4
      summary(20),                              // row 5
      [],                                       // row 6 (blank)
      header("AWB200"),                         // row 7
      parcel({ refno: "EPG000000000000003" }),  // row 8
      summary(10),                              // row 9
    ];
    const { lines } = parseEpgInvoice(rows);
    assert.deepEqual(lines.map((l) => [l.awb, l.sheetRow, l.epgRef]), [
      ["AWB100", 3, "EPG000000000000001"],
      ["AWB100", 4, "EPG000000000000002"],
      ["AWB200", 8, "EPG000000000000003"],
    ]);
  });

  test("skips the 'Total Pieces' summary rows, blank rows and the title row", () => {
    const { lines } = parseEpgInvoice([title(), header("A"), parcel({}), summary(10), [null, null], []]);
    assert.equal(lines.length, 1);
  });

  test("finds columns by name, so a reordered or trimmed layout still parses", () => {
    const columns = ["refno", "trackingno", "total_amt", "CURRENCY", "bill_wt", "Country"]; // no fuel, dims, sell_rate…
    const { lines } = parseEpgInvoice([
      title(), header("A", columns),
      parcel({ refno: "EPG000000000000009", trackingno: "T9", total_amt: 12.34, bill_wt: 1.5 }, columns),
    ]);
    assert.equal(lines[0].epgRef, "EPG000000000000009");
    assert.equal(lines[0].total, 12.34);
    assert.equal(lines[0].billedWeightLb, 1.5);
    assert.equal(lines[0].actualWeightLb, null); // absent column -> null, not 0
    assert.equal(lines[0].fuel, 0); // absent money column -> 0
  });

  test("ignores columns it doesn't know", () => {
    const columns = [...HEADER, "some_new_column"];
    const { lines } = parseEpgInvoice([title(), header("A", columns), parcel({ some_new_column: "x" }, columns)]);
    assert.equal(lines.length, 1);
  });

  test("header names match case-insensitively and ignore padding", () => {
    const columns = ["  REFNO ", "TrackingNo", "TOTAL_AMT"];
    const { lines } = parseEpgInvoice([title(), header("A", columns), ["x", "EPG000000000000005", "T5", 7]]);
    assert.equal(lines[0].epgRef, "EPG000000000000005");
    assert.equal(lines[0].total, 7);
  });

  test("accepts money written as text, with a $ or thousands commas", () => {
    const { lines } = parseEpgInvoice([title(), header("A"), parcel({ total_amt: "$1,234.50", sell_rate: "1,200.00" })]);
    assert.equal(lines[0].total, 1234.5);
    assert.equal(lines[0].sellRate, 1200);
  });

  test("a non-numeric weight becomes null instead of NaN", () => {
    const { lines } = parseEpgInvoice([title(), header("A"), parcel({ bill_wt: "n/a", act_wt: "" })]);
    assert.equal(lines[0].billedWeightLb, null);
    assert.equal(lines[0].actualWeightLb, null);
  });

  test("keeps a parcel that has only one of the two identifiers", () => {
    const { lines } = parseEpgInvoice([
      title(), header("A"),
      parcel({ refno: null, trackingno: "LX1" }),
      parcel({ refno: "EPG000000000000007", trackingno: null }),
    ]);
    assert.deepEqual(lines.map((l) => [l.epgRef, l.finalMileTracking]), [[null, "LX1"], ["EPG000000000000007", null]]);
  });

  test("skips a row with no total, and a row with neither identifier", () => {
    const { lines } = parseEpgInvoice([
      title(), header("A"),
      parcel({ total_amt: null }),
      parcel({ refno: null, trackingno: null }),
      parcel({ refno: "EPG000000000000008" }),
    ]);
    assert.deepEqual(lines.map((l) => l.epgRef), ["EPG000000000000008"]);
  });

  test("defaults the currency to USD when the column is empty", () => {
    const { lines } = parseEpgInvoice([title(), header("A"), parcel({ CURRENCY: null })]);
    assert.equal(lines[0].currency, "USD");
  });

  test("does not dedupe: a parcel listed twice yields two lines (the audit flags the duplicate)", () => {
    const { lines } = parseEpgInvoice([title(), header("A"), parcel({}), parcel({})]);
    assert.equal(lines.length, 2);
  });

  test("rows before the first header are never read as parcels", () => {
    const { lines } = parseEpgInvoice([title(), parcel({ refno: "EPG000000000000004" }), header("A"), parcel({})]);
    assert.equal(lines.length, 1);
    assert.notEqual(lines[0].epgRef, "EPG000000000000004");
  });

  test("rows from several sheets, joined, keep counting sheet rows across them", () => {
    const sheet1: SheetRows = [title(), header("A"), parcel({ refno: "EPG000000000000001" })]; // rows 1-3
    const sheet2: SheetRows = [header("B"), parcel({ refno: "EPG000000000000002" })]; // rows 4-5 once joined
    const { lines } = parseEpgInvoice([...sheet1, ...sheet2]);
    assert.deepEqual(lines.map((l) => l.sheetRow), [3, 5]);
  });

  describe("rejects a file that isn't an EPG package-detail invoice", () => {
    test("no invoice number in the title", () => {
      assert.throws(() => parseEpgInvoice([["Some other report"], header("A"), parcel({})]), (e) => {
        assert.ok(e instanceof ExpectedError);
        assert.match(e.message, /invoice number/i);
        return true;
      });
    });

    test("an empty sheet", () => {
      assert.throws(() => parseEpgInvoice([]), ExpectedError);
    });

    test("an invoice with a title but no parcel rows", () => {
      assert.throws(() => parseEpgInvoice([title("OTCBIX5"), header("A"), summary(0)]), (e) => {
        assert.ok(e instanceof ExpectedError);
        assert.match(e.message, /OTCBIX5/);
        return true;
      });
    });

    test("a header row missing a required column names what's missing", () => {
      const columns = HEADER.filter((c) => c !== "refno");
      assert.throws(() => parseEpgInvoice([title(), header("A", columns), parcel({}, columns)]), (e) => {
        assert.ok(e instanceof ExpectedError);
        assert.match(e.message, /refno/);
        return true;
      });
    });
  });
});
