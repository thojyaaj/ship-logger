import "server-only";

/**
 * DHL Shipment Tracking – Unified API client (PRD §5.2/§10) — a different
 * DHL product from lib/dhl.ts's MyDHL pickup API: single API-key header
 * auth, not client-credentials Basic auth, and a different host entirely.
 * Free tier is rate-limited to 250 calls/day at 1 call per 5 seconds; see
 * lib/dhl-status-cron.ts for how the cron paces itself against that.
 *
 * NOT YET VERIFIED AGAINST LIVE DHL SERVERS — built from DHL's published
 * developer-portal reference (developer.dhl.com/api-reference/shipment-tracking)
 * and its example payloads. Before relying on this, confirm the response
 * shape in `parseTrackResponse` matches a real call.
 *
 * Failure posture matches lib/ups.ts/lib/epg.ts: never throw, treat "couldn't
 * get a status" as a normal, expected outcome for the caller to retry later.
 */

const PROD_BASE = "https://api-eu.dhl.com/track/shipments";

function apiBase(): string {
  return process.env.DHL_TRACKING_API_BASE ?? PROD_BASE;
}

export type DhlTrackStatus = {
  trackingNumber: string;
  statusCode: string | null;
  statusLabel: string | null;
  /** ISO-8601, no UTC offset (DHL returns a bare local timestamp). */
  statusAt: string | null;
  notFound: boolean;
};

type TrackResponse = {
  shipments?: {
    status?: {
      timestamp?: string;
      statusCode?: string;
      status?: string;
      description?: string;
    };
  }[];
};

function parseTrackResponse(trackingNumber: string, data: TrackResponse): DhlTrackStatus {
  const status = data.shipments?.[0]?.status;
  if (!status) {
    return { trackingNumber, statusCode: null, statusLabel: null, statusAt: null, notFound: true };
  }

  return {
    trackingNumber,
    statusCode: status.statusCode ?? null,
    statusLabel: status.description ?? status.status ?? null,
    statusAt: status.timestamp ?? null,
    notFound: false,
  };
}

/** Looks up one tracking number. Never throws — a failure reads as `null`. */
export async function lookupDhlStatus(trackingNumber: string): Promise<DhlTrackStatus | null> {
  const apiKey = process.env.DHL_TRACKING_API_KEY;
  if (!apiKey) return null;

  try {
    const url = new URL(apiBase());
    url.searchParams.set("trackingNumber", trackingNumber);

    const res = await fetch(url, {
      headers: { "DHL-API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    // DHL returns a real 404 for an unrecognized number (unlike UPS's
    // HTTP-200-with-warning shape) — treat that as "not found," not a
    // failure, so the cron doesn't keep retrying it every run for nothing.
    if (res.status === 404) {
      return { trackingNumber, statusCode: null, statusLabel: null, statusAt: null, notFound: true };
    }
    if (!res.ok) return null;

    const data = (await res.json()) as TrackResponse;
    return parseTrackResponse(trackingNumber, data);
  } catch {
    return null;
  }
}
