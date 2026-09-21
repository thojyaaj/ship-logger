import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toCsv, csvPreambleLine } from "./csv";

describe("toCsv", () => {
  test("joins rows with CRLF and quotes cells containing commas, quotes or line breaks", () => {
    assert.equal(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", "cr\rhere"]]), 'a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak","cr\rhere"');
  });

  test("prefixes text that a spreadsheet would run as a formula", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      assert.match(toCsv(["h"], [[bad]]).split("\r\n")[1].replace(/^"/, ""), /^'/, bad);
    }
  });

  test("leaves real numbers alone, so negative amounts stay numbers", () => {
    assert.equal(toCsv(["h"], [[-9.75]]), "h\r\n-9.75");
  });

  test("null and undefined become empty cells", () => {
    assert.equal(toCsv(["a", "b"], [[null, undefined]]), "a,b\r\n,");
  });
});

describe("csvPreambleLine", () => {
  test("joins with | and quotes the line when a part contains a comma", () => {
    assert.equal(csvPreambleLine(["Ship date: 2026-01-01", "AWB: 1"]), "Ship date: 2026-01-01 | AWB: 1");
    assert.equal(csvPreambleLine(["a, b", "c"]), '"a, b | c"');
  });
});
