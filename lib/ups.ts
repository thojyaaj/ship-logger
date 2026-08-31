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
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000 - 5 * 60 * 1000,
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
  const activity = shipment.package?.[0]?.activity?.[0];
  const status = activity?.status;
  const statusAt = activity?.date && activity?.time ? `${activity.date} ${activity.time}` : null;

  return {
    trackingNumber,
    statusCode: status?.code ?? status?.type ?? null,
    statusLabel: status?.description ?? null,
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
