import "server-only";

/**
 * ShipStation v2 API client — read-only label lookup by tracking number.
 * Every EPG/UPS/DHL label the warehouse ships is printed through ShipStation,
 * so a label's `packages[]` carries the real weight/dimensions used to buy
 * it — a source of truth Ship Logger otherwise never gets, since it only
 * records already-printed labels (see docs/PRD.md's "we're recording what
 * already exists").
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
};

type WeightUnit = "pound" | "ounce" | "gram" | "kilogram";
type DimensionUnit = "inch" | "centimeter";

type LabelsResponse = {
  labels?: {
    tracking_number?: string;
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

  return {
    trackingNumber,
    weightLb: toLb(weight.value, weight.unit),
    lengthIn: toInches(dimensions.length, dimensions.unit),
    widthIn: toInches(dimensions.width, dimensions.unit),
    heightIn: toInches(dimensions.height, dimensions.unit),
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
