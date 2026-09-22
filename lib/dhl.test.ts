import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toDhlDimension } from "./dhl";

describe("toDhlDimension", () => {
  test("rounds a repeating average to a multiple of 0.001, the granularity DHL's pickup API enforces", () => {
    // The exact values from a 422: 101/11, 67/11 and 46/11 inches.
    assert.equal(toDhlDimension(9.181818181818182), 9.182);
    assert.equal(toDhlDimension(6.090909090909091), 6.091);
    assert.equal(toDhlDimension(4.181818181818182), 4.182);
  });

  test("serializes with no more than three decimals, since DHL validates the JSON number", () => {
    for (const raw of [9.181818181818182, 1.0005, 12.3456789, 1 / 3]) {
      assert.match(JSON.stringify(toDhlDimension(raw)), /^\d+(\.\d{1,3})?$/, String(raw));
    }
  });

  test("leaves a value already on the grid untouched", () => {
    assert.equal(toDhlDimension(9), 9);
    assert.equal(toDhlDimension(6.5), 6.5);
    assert.equal(toDhlDimension(4.182), 4.182);
  });

  test("never returns 0 — DHL rejects a zero dimension even though it is a multiple of 0.001", () => {
    assert.equal(toDhlDimension(0), 0.001);
    assert.equal(toDhlDimension(0.0004), 0.001);
  });
});
