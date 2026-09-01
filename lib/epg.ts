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

// Character class and laziness are IDENTICAL to the original `([\s\S]*?)`.
// The one and only change is the `{0,16384}` length cap.
//
// The original was unbounded, and being lazy it rescanned to end-of-input for
// every `transactionDetails(` with no following `)"` — quadratic, measured at
// 32s on a 2MB body, enough for one bad response from this uncontracted third
// party to block Node's event loop and stall the instance. Capping the scan
// window fixes that: 3.4s on the same 2MB worst case.
//
// An earlier attempt also added `(?=')` and `[^"]` to narrow the scan further.
// Both were wrong: they assumed the call always opens with a single quote and
// never contains a double quote, and each silently dropped parcels whose real
// markup differed (`transactionDetails( '…` with a space, or any `"` in the
// arguments). A dropped match means a parcel gets no status and no order
// number at all, which is far worse than the DoS those extra guards bought —
// especially since the length cap alone already provides the bound.
const CALL_RE = /transactionDetails\(([\s\S]{0,16384}?)\)"/g;
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
