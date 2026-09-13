import "server-only";

/**
 * On-demand business-insights generator for the Analytics page — sends the
 * current analytics snapshot (real numbers already computed for the page,
 * nothing re-queried here) to Claude and asks for prioritized business
 * recommendations plus Ship Logger product suggestions.
 *
 * Deliberately NOT automatic (no cron, no page-load call): each call costs
 * real tokens, so it only ever runs when an admin clicks the button (see
 * app/(authed)/analytics/actions.ts).
 *
 * "The agent can view the site" is implemented as a written description of
 * Ship Logger's actual current features baked into the prompt below, not
 * literal browser automation — there's no headless-browser infrastructure
 * in this app, and standing one up in a serverless function just to look at
 * pages it already has full data access to would be real infrastructure for
 * no real benefit. If live visual review of the running site is ever
 * actually wanted, that's a separate, much bigger ask.
 */

const API_BASE = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

const SITE_DESCRIPTION = `Ship Logger is this warehouse's internal shipping/tracking app. What it actually does today:
- Packers scan tracking numbers as parcels are packed into a day's outbound shipment ("session"); EPG parcels get consolidated into numbered boxes, UPS/DHL parcels ship individually.
- Every parcel is matched to its Shopify order (via a fulfillment-webhook index for UPS/DHL, EPG's own ERef field for EPG) and tracked for carrier status (delivered/exception/stale) via per-carrier crons.
- Every label (EPG/UPS/DHL) is actually purchased through ShipStation, so Ship Logger backfills each parcel's real weight/dimensions, what was paid, the destination country, and (best-effort, unverified) an on-time-delivery estimate and a rate-shop "could we have paid less" comparison.
- It also pulls what the customer was actually charged for shipping (from Shopify), so it can flag parcels where cost paid exceeded what was charged.
- Admins can dismiss individual or bulk-select exceptions/stale/shipping-loss alerts on an Exceptions page; there's a daily email digest of open ones.
- DHL Express pickups can be scheduled and cancelled directly from a submitted shipment, using real backfilled parcel weight where available.
- The Analytics page (which this prompt's data comes from) shows volume, cost, margin, on-time %, exceptions, and packer activity, both overall and broken out per carrier.`;

export type InsightsResult = { status: "ok"; text: string } | { status: "error"; message: string };

function buildPrompt(windowDays: number, snapshot: unknown): string {
  return `You are a business analyst reviewing real operational data for a small e-commerce warehouse's shipping operation, exported from its internal app, Ship Logger.

${SITE_DESCRIPTION}

Here is a JSON snapshot of the last ${windowDays} days of real data (dollar amounts are USD unless a currency is given; "unverified data source" fields come from a not-fully-confirmed API integration and may be incomplete or inaccurate — say so if you lean on one):

${JSON.stringify(snapshot, null, 2)}

Write two sections in markdown, in plain, direct language — no corporate-speak, no "as an AI" disclaimers, no preamble:

## Business Recommendations
3-6 concrete, prioritized actions grounded specifically in numbers from this snapshot (e.g. name the actual carrier, dollar amount, or percentage that justifies each one). Skip generic shipping advice that isn't actually supported by this data.

## Ship Logger Product Suggestions
2-4 features or changes to the Ship Logger app itself (described above) that would help this operator see or act on what this data reveals is currently hard to see, missing, or manual today. Don't suggest anything that already exists per the description above.

Keep the whole response under 500 words.`;
}

/** Never throws — a failure reads as a typed error result for the UI to show inline. */
export async function generateBusinessInsights(windowDays: number, snapshot: unknown): Promise<InsightsResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: "error", message: "ANTHROPIC_API_KEY is not set — see .env.example." };
  }

  try {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: "user", content: buildPrompt(windowDays, snapshot) }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        status: "error",
        message: `Anthropic API request failed: ${res.status}${body ? ` — ${body.slice(0, 300)}` : ""}`,
      };
    }

    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((block) => block.type === "text")?.text;
    if (!text) return { status: "error", message: "Anthropic API returned no text content." };
    return { status: "ok", text };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "Anthropic API request failed." };
  }
}
