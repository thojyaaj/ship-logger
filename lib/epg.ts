import "server-only";

/**
 * Unofficial ePost Global status lookup — see PRD §5.6.
 *
 * epgtrack.com is a jQuery page, not a SPA: it posts a comma-separated batch
 * of tracking numbers to this endpoint and gets back an HTML fragment with
 * the full record embedded as JSON inside each card's `onclick` attribute.
 * No auth, no key — verified by hand against a real parcel on 2026-08-30.
 *
 * This is undocumented and unsupported. Treat failure as an expected event,
 * not an outage: never let it take the rest of the app down with it.
 */

const ENDPOINT = "https://epgtrack.com/TrackingShipment/ShipmentData";
const BATCH_SIZE = 25; // matches the epgtrack.com UI's own input cap

// Hard ceiling on a response we're willing to parse. epgtrack.com is an
// undocumented third party with no contract, so its response size is not
// something we control. A batch of 25 parcels is a few tens of KB in practice;
// 2 MB is far above any legitimate response and well below the point where
// parsing costs real time.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 500; // >> BATCH_SIZE; guards against unbounded array growth

// The captured argument list is bounded three ways, all deliberate:
//   - `(?=')` — every real call opens with a quoted argument, so this rejects
//     a bare `transactionDetails(` immediately instead of scanning forward.
//   - `[^"]` — the call sits inside an onclick="..." attribute, so its
//     arguments cannot legitimately contain a double quote.
//   - `{0,16384}` — an explicit length cap, sized well above the largest real
//     record observed (a 60-event parcel is ~10KB) so nothing is dropped.
// The previous `([\s\S]*?)` was unbounded, and because it's lazy it rescanned
// to end-of-input for every `transactionDetails(` that had no following `)"`.
// That is quadratic: measured 12ms at 38KB, 218ms at 152KB, 3.9s at 608KB, and
// 32s at 2MB — enough for one bad response from this uncontracted third party
// to block Node's single event loop and stall the whole instance. Measured
// after: 2ms on that same garbage, 3.5s on a worst case crafted to defeat the
// lookahead, and byte-identical output on real-shaped input.
const CALL_RE = /transactionDetails\((?=')([^"]{0,16384}?)\)"/g;
const ARG_RE = /'([^']*)'/g;

export type EpgEvent = {
  category: string;
  categoryId: number;
  event: string;
  eventAt: string; // ISO-ish string as EPG returns it
};

export type EpgRecord = {
  trackingNumber: string;
  externalRef: string | null; // ERef — the Shopify order name, per PRD §5.7
  awb: string | null;
  finalMileCarrier: string | null; // Vendor
  finalMileTracking: string | null; // Track / ITrackNo
  destinationCountry: string | null;
  latestEvent: EpgEvent | null;
  events: EpgEvent[];
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
}

function parseEvent(raw: unknown): EpgEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ECategory !== "string" || typeof r.EventDT !== "string") return null;
  return {
    category: r.ECategory,
    categoryId: typeof r.ECategoryID === "number" ? r.ECategoryID : -1,
    event: typeof r.Event === "string" ? r.Event : r.ECategory,
    eventAt: r.EventDT,
  };
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Parses the raw HTML fragment epgtrack.com returns. Exported for testing.
 * Returns one entry per tracking number in the batch, `record: null` when
 * EPG has no data for that number yet (a brand-new label, or truly unknown).
 */
export function parseEpgResponse(
  html: string,
): { trackingNumber: string; record: EpgRecord | null }[] {
  const results: { trackingNumber: string; record: EpgRecord | null }[] = [];
  let match: RegExpExecArray | null;
  CALL_RE.lastIndex = 0;
  while ((match = CALL_RE.exec(html))) {
    if (results.length >= MAX_RECORDS) break;
    const args = [...match[1].matchAll(ARG_RE)].map((a) => a[1]);
    if (args.length < 5) continue; // malformed call — skip rather than guess
    const trackingNumber = args[2];
    const rawJson = args[4];
    if (!rawJson) {
      results.push({ trackingNumber, record: null });
      continue;
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(decodeHtmlEntities(rawJson));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      results.push({ trackingNumber, record: null });
      continue;
    }
    const events = Array.isArray(parsed.Events)
      ? (parsed.Events as unknown[]).map(parseEvent).filter((e): e is EpgEvent => e !== null)
      : [];
    results.push({
      trackingNumber,
      record: {
        trackingNumber,
        externalRef: nonEmpty(parsed.ERef),
        awb: nonEmpty(parsed.Awb),
        finalMileCarrier: nonEmpty(parsed.Vendor),
        finalMileTracking: nonEmpty(parsed.Track) ?? nonEmpty(parsed.ITrackNo),
        destinationCountry: nonEmpty(parsed.DCt),
        latestEvent: events[0] ?? null, // EPG returns newest-first
        events,
      },
    });
  }
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Looks up a batch of EPG tracking numbers. Never throws for a partial or
 * total failure — callers get an empty map and should treat that as "status
 * unavailable right now", not as a signal anything else is wrong (§8.9).
 */
export async function lookupEpgStatuses(
  trackingNumbers: string[],
): Promise<Map<string, EpgRecord | null>> {
  const results = new Map<string, EpgRecord | null>();
  const batches = chunk(Array.from(new Set(trackingNumbers)), BATCH_SIZE);

  for (const batch of batches) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "ShipLog/1.0 (+internal warehouse tracking tool)",
        },
        body: new URLSearchParams({ id: batch.join(",") }),
        // Be a good citizen (§5.6): this is unofficial, don't hammer it.
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;

      // Reject an oversized body before parsing it. Content-Length is only a
      // hint (it may be absent, or wrong on a chunked response), so the slice
      // below is the actual enforcement — truncating rather than parsing
      // megabytes. A legitimate response never comes close to this.
      const declaredLength = Number(res.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_RESPONSE_BYTES) continue;
      const body = await res.text();
      const html = body.length > MAX_RESPONSE_BYTES ? body.slice(0, MAX_RESPONSE_BYTES) : body;

      for (const { trackingNumber, record } of parseEpgResponse(html)) {
        results.set(trackingNumber, record);
      }
    } catch {
      // Network error, timeout, or the endpoint changed shape. Skip this
      // batch; whatever wasn't set stays "no data" for the caller to retry.
      continue;
    }
  }

  return results;
}
