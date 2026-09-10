import "server-only";
import { newId } from "./id";

/**
 * UPS Track API client — PRD §10 / §5.2. OAuth 2.0 client-credentials grant
 * (same shape as lib/shopify.ts's token caching), then one GET per tracking
 * number against the Track API's details endpoint — there's no batch
 * endpoint like EPG's, so lookupUpsStatuses() just loops.
 *
 * NOT YET VERIFIED AGAINST LIVE UPS SERVERS — built from UPS's published API
 * reference (developer.ups.com) and the PRD's own research, but this repo
 * has no UPS developer credentials to test against. Before relying on this,
 * run it against a real UPS_CLIENT_ID/UPS_CLIENT_SECRET (sandbox is
 * https://wwwcie.ups.com via UPS_API_BASE) and confirm the response shape
 * matches `parseTrackResponse` below — UPS's actual JSON may differ in
 * small ways from the reference docs.
 *
 * Failure posture matches lib/epg.ts: never throw, treat "couldn't get a
 * status" as a normal, expected outcome for the caller to retry later, not
 * as a reason to break the rest of the app.
 */

function apiBase(): string {
  return process.env.UPS_API_BASE ?? "https://onlinetools.ups.com";
}

export type UpsStatus = {
  trackingNumber: string;
  statusCode: string | null;
  statusLabel: string | null;
  /** Raw "YYYYMMDD HHMMSS" as UPS returns it — not yet a parseable Date. */
  statusAt: string | null;
  /** UPS's own signal for "not found / not yet scanned" (warnings[].code === "TW0001", §5.2). */
  notFound: boolean;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const clientId = process.env.UPS_CLIENT_ID;
  const clientSecret = process.env.UPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("UPS_CLIENT_ID / UPS_CLIENT_SECRET are not set.");
  }

  const res = await fetch(`${apiBase()}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) {
    throw new Error(`UPS token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: string | number };

  // Refresh 5 minutes early so a long-running request never straddles expiry.
  // Guard the parse: an absent or non-numeric expires_in made this NaN, and
  // `NaN > Date.now()` is false, so the cache never hit and every single call
  // re-minted a token. Falls back to UPS's documented 4-hour lifetime.
  const lifetimeSeconds = Number(data.expires_in);
  const safeLifetime = Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0 ? lifetimeSeconds : 4 * 60 * 60;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + safeLifetime * 1000 - 5 * 60 * 1000,
  };
  return cachedToken.token;
}

type TrackActivity = {
  status?: { type?: string; code?: string; description?: string };
  date?: string; // "YYYYMMDD"
  time?: string; // "HHMMSS"
};

type TrackResponse = {
  trackResponse?: {
    shipment?: {
      warnings?: { code?: string; message?: string }[];
      package?: {
        trackingNumber?: string;
        activity?: TrackActivity[]; // UPS returns newest-first
        // UPS's consumer tracking site shows these as a separate yellow
        // "clearance pending / missing information" banner above the plain
        // milestone status ("In Warehouse" etc.) — a real customs/action-
        // needed signal the milestone text alone never surfaces. NOT YET
        // VERIFIED against a live response (same caveat as the rest of this
        // file) — field name/shape guessed from UPS's published Track API
        // reference; confirm once real UPS credentials are available and
        // adjust if `alert` turns out to live somewhere else in the payload.
        alert?: { code?: string; description?: string }[];
      }[];
    }[];
  };
};

function parseTrackResponse(trackingNumber: string, data: TrackResponse): UpsStatus {
  const shipment = data.trackResponse?.shipment?.[0];
  if (!shipment) {
    return { trackingNumber, statusCode: null, statusLabel: null, statusAt: null, notFound: true };
  }

  const notFound = (shipment.warnings ?? []).some((w) => w.code === "TW0001");
  const pkg = shipment.package?.[0];
  const activity = pkg?.activity?.[0];
  const status = activity?.status;
  const statusAt = activity?.date && activity?.time ? `${activity.date} ${activity.time}` : null;

  // An alert (customs hold, missing info, etc.) is a stronger, more
  // actionable signal than the plain milestone status, so it's surfaced
  // ahead of it rather than alongside — this is exactly the text
  // lib/shipment-alerts.ts's exception detection needs to see.
  const alertDescription = pkg?.alert?.find((a) => a.description)?.description;
  const statusLabel = alertDescription
    ? status?.description
      ? `${status.description} — ${alertDescription}`
      : alertDescription
    : (status?.description ?? null);

  return {
    trackingNumber,
    statusCode: status?.code ?? status?.type ?? null,
    statusLabel,
    statusAt,
    notFound,
  };
}

/** Looks up one tracking number. Never throws — a failure reads as `null`. */
export async function lookupUpsStatus(trackingNumber: string): Promise<UpsStatus | null> {
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `${apiBase()}/api/track/v1/details/${encodeURIComponent(trackingNumber)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          transId: newId(),
          transactionSrc: "ShipLog",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as TrackResponse;
    // TEMPORARY — diagnosing why UPS's own "clearance pending" banner never
    // shows up in what this app stores (the `alert` field parseTrackResponse
    // reads is an unverified guess). Remove once the real response shape for
    // an in-progress-exception parcel has actually been seen. Truncated to
    // keep one log line from ballooning on a parcel with a long history.
    console.log(`[ups debug] ${trackingNumber} raw:`, JSON.stringify(data).slice(0, 4000));
    return parseTrackResponse(trackingNumber, data);
  } catch {
    return null;
  }
}

/**
 * Batch wrapper for the status cron. UPS's Track API has no multi-number
 * endpoint (unlike EPG's), so this is a sequential loop — fine at this
 * volume (at most one master tracking number per submitted shipment).
 */
export async function lookupUpsStatuses(
  trackingNumbers: string[],
): Promise<Map<string, UpsStatus | null>> {
  const results = new Map<string, UpsStatus | null>();
  for (const trackingNumber of new Set(trackingNumbers)) {
    results.set(trackingNumber, await lookupUpsStatus(trackingNumber));
  }
  return results;
}
