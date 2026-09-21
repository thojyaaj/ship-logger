import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, signIntakeRequest, verifyIntakeRequest } from "./intake-auth";

const PATH = "/api/v1/invoices/epg";
const SECRET = "test-secret";
const NOW = 1_800_000_000;
const body = new TextEncoder().encode("xlsx-bytes");

function request(headers: Record<string, string>, path = PATH) {
  return new Request(`https://example.test${path}`, { method: "POST", headers });
}
function signed(overrides: Record<string, string> = {}, opts: { secret?: string; ts?: number; body?: Uint8Array; path?: string } = {}) {
  const ts = String(opts.ts ?? NOW);
  const signature = signIntakeRequest(opts.secret ?? SECRET, "POST", opts.path ?? PATH, ts, sha256Hex(opts.body ?? body));
  return request({
    "x-shiplogger-caller": "gmail-apps-script",
    "x-shiplogger-timestamp": ts,
    "x-shiplogger-signature": signature,
    ...overrides,
  });
}

describe("verifyIntakeRequest", () => {
  const original = process.env.INVOICE_INTAKE_SECRET_GMAIL;
  beforeEach(() => {
    process.env.INVOICE_INTAKE_SECRET_GMAIL = SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.INVOICE_INTAKE_SECRET_GMAIL;
    else process.env.INVOICE_INTAKE_SECRET_GMAIL = original;
  });

  test("accepts a correctly signed request", () => {
    assert.deepEqual(verifyIntakeRequest(signed(), PATH, body, NOW), { ok: true, caller: "gmail-apps-script" });
  });

  test("rejects a body that was changed after signing", () => {
    const r = verifyIntakeRequest(signed(), PATH, new TextEncoder().encode("tampered"), NOW);
    assert.equal(r.ok, false);
  });

  test("rejects a signature made with the wrong secret", () => {
    assert.equal(verifyIntakeRequest(signed({}, { secret: "other" }), PATH, body, NOW).ok, false);
  });

  test("a signature is bound to its path", () => {
    assert.equal(verifyIntakeRequest(signed({}, { path: "/api/v1/invoices/ups" }), PATH, body, NOW).ok, false);
  });

  test("timestamps: 5 minutes either way is accepted, beyond that (a replay) is not", () => {
    assert.equal(verifyIntakeRequest(signed({}, { ts: NOW - 300 }), PATH, body, NOW).ok, true);
    assert.equal(verifyIntakeRequest(signed({}, { ts: NOW + 300 }), PATH, body, NOW).ok, true);
    assert.equal(verifyIntakeRequest(signed({}, { ts: NOW - 301 }), PATH, body, NOW).ok, false);
    assert.equal(verifyIntakeRequest(signed({}, { ts: NOW + 301 }), PATH, body, NOW).ok, false);
  });

  test("rejects a missing or malformed timestamp or signature", () => {
    assert.equal(verifyIntakeRequest(signed({ "x-shiplogger-timestamp": "abc" }), PATH, body, NOW).ok, false);
    assert.equal(verifyIntakeRequest(signed({ "x-shiplogger-timestamp": "" }), PATH, body, NOW).ok, false);
    assert.equal(verifyIntakeRequest(signed({ "x-shiplogger-signature": "zz" }), PATH, body, NOW).ok, false);
    assert.equal(verifyIntakeRequest(signed({ "x-shiplogger-signature": "" }), PATH, body, NOW).ok, false);
  });

  test("rejects an unknown caller, including names that are properties of every object", () => {
    for (const caller of ["nobody", "", "toString", "__proto__", "constructor"]) {
      assert.equal(verifyIntakeRequest(signed({ "x-shiplogger-caller": caller }), PATH, body, NOW).ok, false, caller);
    }
  });

  test("with no secret configured it fails closed with a 503, not a 401", () => {
    delete process.env.INVOICE_INTAKE_SECRET_GMAIL;
    const r = verifyIntakeRequest(signed(), PATH, body, NOW);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 503);
  });
});
