import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyLine, PRICE_TOLERANCE, type Quote } from "./classify";

const quote = (amount: number | null, extra: Partial<Quote> = {}): Quote => ({
  found: true, amount, currency: "USD", weightLb: 0.2, ...extra,
});
const base = { invoicedCurrency: "USD", billedWeightLb: 0.2, duplicate: false };

describe("classifyLine — price", () => {
  test("an exact match is a match", () => {
    assert.deepEqual(classifyLine({ ...base, invoicedAmount: 9.73, quote: quote(9.73) }), { status: "match", difference: 0, billedHeavier: false });
  });

  test("a difference of exactly the tolerance is still a match; a cent more is not", () => {
    assert.equal(PRICE_TOLERANCE, 0.05);
    assert.equal(classifyLine({ ...base, invoicedAmount: 9.78, quote: quote(9.73) }).status, "match"); // +0.05
    assert.equal(classifyLine({ ...base, invoicedAmount: 9.68, quote: quote(9.73) }).status, "match"); // -0.05
    assert.equal(classifyLine({ ...base, invoicedAmount: 9.79, quote: quote(9.73) }).status, "over"); // +0.06
    assert.equal(classifyLine({ ...base, invoicedAmount: 9.67, quote: quote(9.73) }).status, "under"); // -0.06
  });

  test("overcharged reports the positive difference, rounded to cents", () => {
    assert.deepEqual(classifyLine({ ...base, invoicedAmount: 10.5, quote: quote(9.73) }), { status: "over", difference: 0.77, billedHeavier: false });
  });

  test("undercharged reports the negative difference", () => {
    assert.deepEqual(classifyLine({ ...base, invoicedAmount: 9, quote: quote(9.73) }), { status: "under", difference: -0.73, billedHeavier: false });
  });

  test("float noise doesn't tip a match into an overcharge", () => {
    assert.equal(classifyLine({ ...base, invoicedAmount: 0.3, quote: quote(0.1 + 0.2) }).status, "match");
  });
});

describe("classifyLine — things that aren't a price comparison", () => {
  test("a parcel found but with no cost is 'no quote'", () => {
    assert.deepEqual(classifyLine({ ...base, invoicedAmount: 9, quote: quote(null) }), { status: "no_quote", difference: null, billedHeavier: false });
  });

  test("a parcel nothing knows about is 'not found'", () => {
    const q: Quote = { found: false, amount: null, currency: null, weightLb: null };
    assert.equal(classifyLine({ ...base, invoicedAmount: 9, quote: q }).status, "not_found");
  });

  test("a quote in another currency isn't compared", () => {
    assert.deepEqual(classifyLine({ ...base, invoicedAmount: 9, quote: quote(9, { currency: "CAD" }) }), { status: "currency_mismatch", difference: null, billedHeavier: false });
  });

  test("currency codes compare case-insensitively; a quote with no currency is assumed to match", () => {
    assert.equal(classifyLine({ ...base, invoicedAmount: 9, quote: quote(9, { currency: "usd" }) }).status, "match");
    assert.equal(classifyLine({ ...base, invoicedAmount: 9, quote: quote(9, { currency: null }) }).status, "match");
  });

  test("a duplicate is wrong in full, whatever the quote says", () => {
    assert.deepEqual(classifyLine({ ...base, duplicate: true, invoicedAmount: 9.73, quote: quote(9.73) }), { status: "duplicate", difference: 9.73, billedHeavier: false });
    assert.equal(classifyLine({ ...base, duplicate: true, invoicedAmount: 9.73, quote: quote(null) }).status, "duplicate");
  });
});

describe("classifyLine — billed heavier than the label", () => {
  const heavier = (billed: number, labelWeight: number) =>
    classifyLine({ ...base, billedWeightLb: billed, invoicedAmount: 9, quote: quote(9, { weightLb: labelWeight }) }).billedHeavier;

  test("small differences (scale noise) don't count: margin is the larger of 0.1 lb and 10%", () => {
    assert.equal(heavier(0.29, 0.2), false); // +0.09 < 0.1 lb
    assert.equal(heavier(0.3, 0.2), false); // exactly +0.1 lb is not past the margin
    assert.equal(heavier(0.35, 0.2), true);
  });

  test("on a heavy parcel the 10% margin applies", () => {
    assert.equal(heavier(2.15, 2), false); // +0.15 < 0.2 (10% of 2 lb)
    assert.equal(heavier(2.25, 2), true);
  });

  test("billed lighter than the label is never 'heavier'", () => {
    assert.equal(heavier(0.1, 0.5), false);
  });

  test("needs both weights", () => {
    assert.equal(classifyLine({ ...base, billedWeightLb: null, invoicedAmount: 9, quote: quote(9) }).billedHeavier, false);
    assert.equal(classifyLine({ ...base, invoicedAmount: 9, quote: quote(9, { weightLb: null }) }).billedHeavier, false);
    assert.equal(classifyLine({ ...base, invoicedAmount: 9, quote: quote(9, { weightLb: 0 }) }).billedHeavier, false);
  });

  test("is reported alongside the price verdict, even when the price matches", () => {
    const v = classifyLine({ ...base, billedWeightLb: 1.2, invoicedAmount: 9, quote: quote(9, { weightLb: 0.4 }) });
    assert.deepEqual([v.status, v.billedHeavier], ["match", true]);
  });
});
