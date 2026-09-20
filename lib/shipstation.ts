import "server-only";

/**
 * ShipStation v2 API client — read-only label lookup by tracking number.
 * Every EPG/UPS/DHL label the warehouse ships is printed through ShipStation,
 * so a label carries the real weight/dimensions and cost used to buy it — a
 * source of truth Ship Logger otherwise never gets, since it only records
 * already-printed labels (see docs/PRD.md's "we're recording what already
 * exists").
 *
 * NOT YET VERIFIED AGAINST A LIVE SHIPSTATION RESPONSE — built from
 * ShipStation's published v2 API reference (docs.shipstation.com/list-labels)
 * rather than a real call. Before relying on this, confirm against a
 * real/sandbox API key that the response is wrapped in a `labels` array (the
 * documented list shape) and that `weight.unit`/`dimensions.unit` use the
 * values assumed by `toLb`/`toInches` below.
 *
 * Failure posture matches every other carrier client in this app
 * (lib/dhl-track.ts, lib/ups.ts, lib/epg.ts): never throws, a failure or
 * "not found" both read as `null` for the caller to retry later.
 */

import { normalizeTrackingNumber } from "./carrier";

const PROD_BASE = "https://api.shipstation.com/v2";

function apiBase(): string {
  return process.env.SHIPSTATION_API_BASE ?? PROD_BASE;
}

export type ShipstationLabel = {
  trackingNumber: string;
  // Nullable independently of cost/carrierCode below — a label can be found
  // with no package weight/dimensions on file (an older or manually-entered
  // label), which shouldn't block cost from being reported. Caught live: a
  // scan with a real cost paid was showing no cost at all because this used
  // to return `null` outright whenever weight/dimensions were missing,
  // discarding cost along with them.
  weightLb: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  /** What was actually paid for this label — null when the label response carries no cost (e.g. a void). */
  costAmount: number | null;
  costCurrency: string | null;
  /** ShipStation's own carrier code (e.g. "ups", "dhl_express") — captured here rather than guessed, so lookupShipstationTracking's carrier_code param is always the real one for this label, not a mapping this app made up. */
  carrierCode: string | null;
  /** The label's ship date as a date-only string ("YYYY-MM-DD"); documented `ship_date` on GET /v2/labels. */
  shipDate: string | null;
};

type WeightUnit = "pound" | "ounce" | "gram" | "kilogram";
type DimensionUnit = "inch" | "centimeter";

type LabelsResponse = {
  labels?: {
    tracking_number?: string;
    carrier_code?: string;
    ship_date?: string | null;
    shipment_cost?: { amount?: number; currency?: string };
    packages?: {
      weight?: { value?: number; unit?: WeightUnit };
      dimensions?: { length?: number; width?: number; height?: number; unit?: DimensionUnit };
    }[];
  }[];
};

function toLb(value: number, unit: WeightUnit): number {
  switch (unit) {
    case "pound":
      return value;
    case "ounce":
      return value / 16;
    case "kilogram":
      return value * 2.2046226218;
    case "gram":
      return value * 0.0022046226;
  }
}

function toInches(value: number, unit: DimensionUnit): number {
  return unit === "centimeter" ? value / 2.54 : value;
}

function parseLabel(trackingNumber: string, data: LabelsResponse): ShipstationLabel | null {
  const label = data.labels?.[0];
  if (!label) return null;

  const pkg = label.packages?.[0];
  const weight = pkg?.weight;
  const dimensions = pkg?.dimensions;
  const hasWeightAndDimensions =
    weight?.value && weight.unit && dimensions?.length && dimensions.width && dimensions.height && dimensions.unit;

  const cost = label.shipment_cost;
  return {
    trackingNumber,
    weightLb: hasWeightAndDimensions ? toLb(weight.value!, weight.unit!) : null,
    lengthIn: hasWeightAndDimensions ? toInches(dimensions!.length!, dimensions!.unit!) : null,
    widthIn: hasWeightAndDimensions ? toInches(dimensions!.width!, dimensions!.unit!) : null,
    heightIn: hasWeightAndDimensions ? toInches(dimensions!.height!, dimensions!.unit!) : null,
    costAmount: cost?.amount ?? null,
    costCurrency: cost?.currency ?? null,
    carrierCode: label.carrier_code ?? null,
    shipDate: dateOnly(label.ship_date),
  };
}

/** ShipStation timestamps look like "2024-09-23T00:00:00.000Z"; the calendar day is what matters here. */
function dateOnly(value: string | null | undefined): string | null {
  const day = value?.slice(0, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Looks up the completed label for one tracking number. Never throws — any failure reads as `null`. */
export async function lookupShipstationLabel(trackingNumber: string): Promise<ShipstationLabel | null> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  // Logged, not just silently returned — every caller (the cron, and
  // recordScan's scan-time after() lookup) treats null identically whether
  // it means "not configured," "ShipStation doesn't have this label yet,"
  // or "the API call failed," so without a log line there was no way to
  // tell those apart from the outside when weight wasn't showing up.
  if (!apiKey) {
    console.warn("[shipstation] SHIPSTATION_API_KEY not set — skipping lookup for", trackingNumber);
    return null;
  }

  try {
    const url = new URL(`${apiBase()}/labels`);
    url.searchParams.set("tracking_number", trackingNumber);
    url.searchParams.set("label_status", "completed");
    url.searchParams.set("page_size", "1");

    const res = await fetch(url, {
      headers: { "API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error(`[shipstation] labels lookup for ${trackingNumber} failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as LabelsResponse;
    const label = parseLabel(trackingNumber, data);
    if (!label) {
      console.warn("[shipstation] no completed label found yet for", trackingNumber);
    } else if (label.weightLb === null) {
      console.warn("[shipstation] label found for", trackingNumber, "but it carries no weight/dimensions");
    }
    return label;
  } catch (err) {
    console.error(`[shipstation] labels lookup for ${trackingNumber} threw:`, err);
    return null;
  }
}

export type ShipstationShipment = {
  trackingNumber: string;
  /** The label's ship date ("YYYY-MM-DD"), from the same label lookup that finds the shipment. */
  shipDate: string | null;
  /** The order-source's own order id/number (e.g. Shopify's), confirmed field on GET /v2/shipments. Used only as a fallback when Shopify's own order-matching (lib/order-index.ts) comes up empty — never as a replacement for it. */
  externalOrderId: string | null;
  shipToName: string | null;
  shipToPostalCode: string | null;
  shipToCountryCode: string | null;
  shipToCityLocality: string | null;
  shipToStateProvince: string | null;
};

type LabelLookupResponse = {
  labels?: { tracking_number?: string; shipment_id?: string; ship_date?: string | null }[];
};

type ShipmentResponse = {
  shipment_id?: string;
  external_order_id?: string | null;
  ship_to?: {
    name?: string | null;
    postal_code?: string | null;
    country_code?: string | null;
    city_locality?: string | null;
    state_province?: string | null;
  } | null;
};

function parseShipment(trackingNumber: string, shipment: ShipmentResponse, shipDate: string | null): ShipstationShipment {
  const shipTo = shipment.ship_to;
  return {
    trackingNumber,
    shipDate,
    externalOrderId: shipment.external_order_id ?? null,
    shipToName: shipTo?.name ?? null,
    shipToPostalCode: shipTo?.postal_code ?? null,
    shipToCountryCode: shipTo?.country_code ?? null,
    shipToCityLocality: shipTo?.city_locality ?? null,
    shipToStateProvince: shipTo?.state_province ?? null,
  };
}

export type ShipstationParcelLookup =
  | { status: "found"; shipment: ShipstationShipment }
  /** ShipStation answered, and has no completed label for this tracking number. */
  | { status: "not_found" }
  /** The API call itself failed (rate limit, outage, no key) — worth retrying, unlike not_found. */
  | { status: "error" };

/**
 * Looks up the shipment (order + ship-to) behind one tracking number, telling
 * "ShipStation has no such label" apart from "the call failed". Used by the
 * invoice audit's enrichment (lib/invoice-audit/enrich.ts), which must not
 * permanently mark a parcel as missing over a transient error.
 *
 * Two steps on purpose: `GET /v2/shipments` has no `tracking_number` filter
 * (its documented filters are batch_id, tag, shipment_status, created/modified
 * date ranges and sales_order_id), so the old single call silently returned
 * the account's newest shipment for *every* tracking number — one stranger's
 * name and address stamped onto unrelated parcels. `GET /v2/labels` does
 * filter by tracking number, and its label carries the `shipment_id` to fetch.
 * Both hops verify what came back is the record that was asked for, because
 * an ignored filter is otherwise indistinguishable from a real answer.
 */
export async function lookupShipstationParcel(
  trackingNumber: string,
  // false skips the second hop (the shipment, which only adds the order id),
  // for a caller that just wants the label's ship date.
  opts: { shipment?: boolean } = {},
): Promise<ShipstationParcelLookup> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) return { status: "error" };

  try {
    const labelUrl = new URL(`${apiBase()}/labels`);
    labelUrl.searchParams.set("tracking_number", trackingNumber);
    labelUrl.searchParams.set("label_status", "completed");
    labelUrl.searchParams.set("page_size", "1");

    const labelRes = await fetch(labelUrl, {
      headers: { "API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!labelRes.ok) return { status: "error" };

    const label = ((await labelRes.json()) as LabelLookupResponse).labels?.[0];
    if (!label?.shipment_id || normalizeTrackingNumber(label.tracking_number ?? "") !== normalizeTrackingNumber(trackingNumber)) {
      return { status: "not_found" };
    }

    if (opts.shipment === false) {
      return { status: "found", shipment: parseShipment(trackingNumber, {}, dateOnly(label.ship_date)) };
    }

    const shipmentRes = await fetch(`${apiBase()}/shipments/${encodeURIComponent(label.shipment_id)}`, {
      headers: { "API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!shipmentRes.ok) return { status: "error" };

    const shipment = (await shipmentRes.json()) as ShipmentResponse;
    if (shipment.shipment_id !== label.shipment_id) return { status: "error" };
    return { status: "found", shipment: parseShipment(trackingNumber, shipment, dateOnly(label.ship_date)) };
  } catch {
    return { status: "error" };
  }
}

/**
 * Looks up the shipment (order + ship-to) behind one tracking number. Used
 * two ways: as an order-match fallback (lib/shipstation-order-fallback-cron.ts)
 * when Shopify's own matching has nothing, and as the destination address
 * feeding rate-shop estimates (lib/shipstation-rates.ts) — same call, two
 * independent callers, neither one persists more of the response than it
 * needs. Never throws — any failure reads as `null`; see
 * lookupShipstationParcel for why the two hops verify what they got back.
 */
export async function lookupShipstationShipment(trackingNumber: string): Promise<ShipstationShipment | null> {
  const result = await lookupShipstationParcel(trackingNumber);
  return result.status === "found" ? result.shipment : null;
}

/**
 * GENUINELY UNVERIFIED — more so than every other function in this file.
 * `estimated_delivery_date`/`actual_delivery_date` are confirmed fields to
 * exist somewhere in ShipStation's docs, but the only endpoint found for
 * them (`GET /v1/tracking?carrier_code=...&tracking_number=...`) sits under
 * a `/v1`, ShipEngine-branded doc path — a different version number than
 * every other endpoint this app calls (`/v2/...`). Before trusting this:
 * confirm (a) whether `PROD_BASE`/`SHIPSTATION_API_KEY` even work against
 * `/v1/tracking` or whether it needs a different host/key entirely, and
 * (b) whether the `carrier_code` a `/v2/labels` response returns (what
 * `lookupShipstationLabel` now captures and this function is fed) is the
 * same vocabulary `/v1/tracking` expects — it may not be, since v1 and v2
 * are different API generations. Degrades to `null` on any failure — a
 * wrong guess here only means the on-time-delivery analytics stay empty,
 * nothing else in this app depends on it.
 */
export type ShipstationTracking = {
  trackingNumber: string;
  estimatedDeliveryAt: string | null;
  actualDeliveryAt: string | null;
};

type TrackingResponse = {
  estimated_delivery_date?: string | null;
  actual_delivery_date?: string | null;
};

const TRACKING_BASE = "https://api.shipstation.com/v1";

export async function lookupShipstationTracking(
  carrierCode: string,
  trackingNumber: string,
): Promise<ShipstationTracking | null> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) return null;

  try {
    const url = new URL(`${process.env.SHIPSTATION_TRACKING_API_BASE ?? TRACKING_BASE}/tracking`);
    url.searchParams.set("carrier_code", carrierCode);
    url.searchParams.set("tracking_number", trackingNumber);

    const res = await fetch(url, {
      headers: { "API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    // TEMP: diagnosing the "genuinely unverified" endpoint/auth guess above
    // against a real ShipStation account — see get_runtime_logs once this is
    // deployed and the cron has run. Revert once diagnosed (matches this
    // repo's own precedent, commit 229ad38).
    const rawBody = await res.text();
    console.log(
      `[shipstation-tracking][DIAG] url=${url.toString()} status=${res.status} body=${rawBody.slice(0, 500)}`,
    );

    if (!res.ok) return null;

    const data = JSON.parse(rawBody) as TrackingResponse;
    return {
      trackingNumber,
      estimatedDeliveryAt: data.estimated_delivery_date ?? null,
      actualDeliveryAt: data.actual_delivery_date ?? null,
    };
  } catch (err) {
    console.log(`[shipstation-tracking][DIAG] threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
