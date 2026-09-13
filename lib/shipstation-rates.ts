import "server-only";

/**
 * ShipStation v2 Rate Shopping — POST /v2/rates/estimate, compares what a
 * shipment would cost across connected carriers/services right now, to
 * measure against what was actually paid (lib/analytics.ts's
 * getRateShopSavings).
 *
 * GENUINELY UNVERIFIED, same posture as lib/shipstation.ts's
 * lookupShipstationTracking: the docs page for this endpoint is
 * JS-rendered and only a heading ("Estimate rates") could be fetched, not
 * the actual request/response JSON schema. Field names below are built from
 * search-result summaries of the endpoint plus the well-known ShipEngine
 * rate-object shape ShipStation v2 is built on — NOT a confirmed live
 * payload. `extractRates` defensively tries the three most likely response
 * envelope shapes rather than assuming one, and everything degrades to
 * `null` on any mismatch or failure, so a wrong guess here just means the
 * rate-shop savings analytics stay empty.
 */

const PROD_BASE = "https://api.shipstation.com/v2";

function apiBase(): string {
  return process.env.SHIPSTATION_API_BASE ?? PROD_BASE;
}

export type RateEstimateInput = {
  fromCountryCode: string;
  fromPostalCode: string;
  toCountryCode: string;
  toPostalCode: string;
  toCityLocality: string | null;
  toStateProvince: string | null;
  weightLb: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
};

export type BestRateEstimate = {
  amount: number;
  currency: string;
  carrierCode: string | null;
};

type RateQuote = {
  carrier_code?: string;
  shipping_amount?: { amount?: number; currency?: string };
};

type RatesEstimateResponse = RateQuote[] | { rates?: RateQuote[] } | { rate_response?: { rates?: RateQuote[] } };

function extractRates(data: RatesEstimateResponse): RateQuote[] {
  if (Array.isArray(data)) return data;
  if ("rate_response" in data && data.rate_response?.rates) return data.rate_response.rates;
  if ("rates" in data && data.rates) return data.rates;
  return [];
}

/** Cheapest quote across whatever carriers/services the account has connected. Never throws — any failure or empty response reads as `null`. */
export async function estimateBestRate(input: RateEstimateInput): Promise<BestRateEstimate | null> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) return null;

  try {
    // Optional — omitted unless configured, since it's unconfirmed whether
    // the endpoint requires it or defaults to comparing every connected
    // carrier on its own.
    const carrierIds = process.env.SHIPSTATION_RATE_CARRIER_IDS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const body = {
      from_country_code: input.fromCountryCode,
      from_postal_code: input.fromPostalCode,
      to_country_code: input.toCountryCode,
      to_postal_code: input.toPostalCode,
      to_city_locality: input.toCityLocality ?? undefined,
      to_state_province: input.toStateProvince ?? undefined,
      weight: { value: input.weightLb, unit: "pound" },
      dimensions: { unit: "inch", length: input.lengthIn, width: input.widthIn, height: input.heightIn },
      ...(carrierIds && carrierIds.length > 0 ? { carrier_ids: carrierIds } : {}),
    };

    const res = await fetch(`${apiBase()}/rates/estimate`, {
      method: "POST",
      headers: { "API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    // TEMP: diagnosing the "genuinely unverified" request/response shape
    // above against a real ShipStation account — see get_runtime_logs once
    // this is deployed and the cron has run. Revert once diagnosed (matches
    // this repo's own precedent, commit 229ad38).
    const rawBody = await res.text();
    console.log(
      `[shipstation-rates][DIAG] status=${res.status} request=${JSON.stringify(body)} response=${rawBody.slice(0, 800)}`,
    );

    if (!res.ok) return null;

    const data = JSON.parse(rawBody) as RatesEstimateResponse;
    const withAmount = extractRates(data).filter(
      (r): r is RateQuote & { shipping_amount: { amount: number; currency?: string } } =>
        typeof r.shipping_amount?.amount === "number",
    );
    if (withAmount.length === 0) return null;

    const best = withAmount.reduce((min, r) => (r.shipping_amount.amount < min.shipping_amount.amount ? r : min));
    return {
      amount: best.shipping_amount.amount,
      currency: best.shipping_amount.currency ?? "usd",
      carrierCode: best.carrier_code ?? null,
    };
  } catch (err) {
    console.log(`[shipstation-rates][DIAG] threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
