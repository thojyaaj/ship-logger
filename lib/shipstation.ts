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

const PROD_BASE = "https://api.shipstation.com/v2";

function apiBase(): string {
  return process.env.SHIPSTATION_API_BASE ?? PROD_BASE;
}

export type ShipstationLabel = {
  trackingNumber: string;
  weightLb: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  /** What was actually paid for this label — null when the label response carries no cost (e.g. a void). */
  costAmount: number | null;
  costCurrency: string | null;
};

type WeightUnit = "pound" | "ounce" | "gram" | "kilogram";
type DimensionUnit = "inch" | "centimeter";

type LabelsResponse = {
  labels?: {
    tracking_number?: string;
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
  const pkg = label?.packages?.[0];
  const weight = pkg?.weight;
  const dimensions = pkg?.dimensions;
  if (!weight?.value || !weight.unit || !dimensions?.length || !dimensions.width || !dimensions.height || !dimensions.unit) {
    return null;
  }

  const cost = label?.shipment_cost;
  return {
    trackingNumber,
    weightLb: toLb(weight.value, weight.unit),
    lengthIn: toInches(dimensions.length, dimensions.unit),
    widthIn: toInches(dimensions.width, dimensions.unit),
    heightIn: toInches(dimensions.height, dimensions.unit),
    costAmount: cost?.amount ?? null,
    costCurrency: cost?.currency ?? null,
  };
}

/** Looks up the completed label for one tracking number. Never throws — any failure reads as `null`. */
export async function lookupShipstationLabel(trackingNumber: string): Promise<ShipstationLabel | null> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) return null;

  try {
    const url = new URL(`${apiBase()}/labels`);
    url.searchParams.set("tracking_number", trackingNumber);
    url.searchParams.set("label_status", "completed");
    url.searchParams.set("page_size", "1");

    const res = await fetch(url, {
      headers: { "API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as LabelsResponse;
    return parseLabel(trackingNumber, data);
  } catch {
    return null;
  }
}

export type ShipstationShipment = {
  trackingNumber: string;
  /** The order-source's own order id/number (e.g. Shopify's), confirmed field on GET /v2/shipments. Used only as a fallback when Shopify's own order-matching (lib/order-index.ts) comes up empty — never as a replacement for it. */
  externalOrderId: string | null;
  shipToName: string | null;
  shipToPostalCode: string | null;
  shipToCountryCode: string | null;
  shipToCityLocality: string | null;
  shipToStateProvince: string | null;
};

type ShipmentsResponse = {
  shipments?: {
    tracking_number?: string;
    external_order_id?: string | null;
    ship_to?: {
      name?: string | null;
      postal_code?: string | null;
      country_code?: string | null;
      city_locality?: string | null;
      state_province?: string | null;
    } | null;
  }[];
};

function parseShipment(trackingNumber: string, data: ShipmentsResponse): ShipstationShipment | null {
  const shipment = data.shipments?.[0];
  if (!shipment) return null;
  const shipTo = shipment.ship_to;
  return {
    trackingNumber,
    externalOrderId: shipment.external_order_id ?? null,
    shipToName: shipTo?.name ?? null,
    shipToPostalCode: shipTo?.postal_code ?? null,
    shipToCountryCode: shipTo?.country_code ?? null,
    shipToCityLocality: shipTo?.city_locality ?? null,
    shipToStateProvince: shipTo?.state_province ?? null,
  };
}

/**
 * Looks up the shipment (order + ship-to) behind one tracking number. Used
 * two ways: as an order-match fallback (lib/shipstation-order-fallback-cron.ts)
 * when Shopify's own matching has nothing, and as the destination address
 * feeding rate-shop estimates (lib/shipstation-rates.ts) — same call, two
 * independent callers, neither one persists more of the response than it
 * needs. Never throws — any failure reads as `null`.
 */
export async function lookupShipstationShipment(trackingNumber: string): Promise<ShipstationShipment | null> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) return null;

  try {
    const url = new URL(`${apiBase()}/shipments`);
    url.searchParams.set("tracking_number", trackingNumber);
    url.searchParams.set("page_size", "1");

    const res = await fetch(url, {
      headers: { "API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as ShipmentsResponse;
    return parseShipment(trackingNumber, data);
  } catch {
    return null;
  }
}
