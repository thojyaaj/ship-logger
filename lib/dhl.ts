import "server-only";
import { newId } from "./id";

/**
 * DHL Express MyDHL API client — pickup scheduling only (not shipping/labels).
 * REST/JSON, HTTP Basic Auth (API key + secret as username/password); the
 * DHL Express account number is a separate request-body field, not part of
 * auth. Production base https://express.api.dhl.com/mydhlapi, test base
 * .../mydhlapi/test (override via DHL_API_BASE).
 *
 * NOT YET VERIFIED AGAINST LIVE DHL SERVERS. Built from DHL's published
 * developer-portal reference (developer.dhl.com) and its example payloads —
 * this app has no DHL API credentials to test against yet. Obtaining them
 * requires DHL-side onboarding tied to an active DHL Express account, not
 * pure self-service registration. Before relying on this: get real
 * DHL_CLIENT_ID/DHL_CLIENT_SECRET, request pickups against DHL_API_BASE's
 * test environment first, and confirm the response shape matches
 * `PickupApiResponse` below — exact field names for a couple of secondary
 * fields (see comments) were not fully confirmed from documentation alone.
 *
 * Failure posture: never throws to the caller — every failure path returns
 * `{ status: "error", message }`, matching every other external client in
 * this app (lib/ups.ts, lib/epg.ts).
 */

const PROD_BASE = "https://express.api.dhl.com/mydhlapi";

function apiBase(): string {
  return process.env.DHL_API_BASE ?? PROD_BASE;
}

export type PickupAddress = {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
};

export type PickupPackageDimensions = {
  length: number;
  width: number;
  height: number;
};

export type PickupRequestInput = {
  accountNumber: string;
  /** Full ISO-8601 timestamp with UTC offset, e.g. "2026-07-04T09:00:00-05:00". */
  plannedPickupDateAndTime: string;
  /** Location closing time, "HH:MM". */
  closeTime: string;
  companyName: string;
  contactName: string;
  contactPhone: string;
  address: PickupAddress;
  parcelCount: number;
  totalWeightLb: number;
  /** Per-package estimate, inches — required by DHL's pickup API even though
   * packages here aren't individually measured (see lib/dhl-pickup.ts). */
  dimensions: PickupPackageDimensions;
  specialInstructions?: string;
};

export type PickupRequestResult =
  | { status: "ok"; dispatchConfirmationNumber: string }
  | { status: "error"; message: string };

type PickupApiResponse = {
  dispatchConfirmationNumbers?: string[];
};

function authHeader(): string {
  const key = process.env.DHL_CLIENT_ID;
  const secret = process.env.DHL_CLIENT_SECRET;
  if (!key || !secret) {
    throw new Error(
      "DHL pickup scheduling isn't configured yet — DHL_CLIENT_ID / DHL_CLIENT_SECRET are not set.",
    );
  }
  return `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
}

export async function requestDhlPickup(input: PickupRequestInput): Promise<PickupRequestResult> {
  try {
    const body = {
      plannedPickupDateAndTime: input.plannedPickupDateAndTime,
      closeTime: input.closeTime,
      location: "business",
      locationType: "business",
      accounts: [{ typeCode: "shipper", number: input.accountNumber }],
      customerDetails: {
        shipperDetails: {
          postalAddress: {
            addressLine1: input.address.addressLine1,
            addressLine2: input.address.addressLine2,
            cityName: input.address.city,
            provinceCode: input.address.state,
            postalCode: input.address.postalCode,
            countryCode: input.address.countryCode,
          },
          contactInformation: {
            companyName: input.companyName,
            fullName: input.contactName,
            phone: input.contactPhone,
          },
        },
      },
      shipmentDetails: [
        {
          productCode: "P", // DHL Express Worldwide — the general product code
          isCustomsDeclarable: false,
          unitOfMeasurement: "imperial",
          packages: [
            {
              weight: input.totalWeightLb,
              dimensions: {
                length: input.dimensions.length,
                width: input.dimensions.width,
                height: input.dimensions.height,
              },
            },
          ],
          // Some DHL examples carry parcel count at the package level (one
          // entry per package) rather than as a single count field; this app
          // scans up to a few dozen parcels a day, well under any documented
          // batching limit, so one aggregate package entry with the total
          // weight/dimensions is used rather than generating input.parcelCount
          // separate package entries with an assumed per-package split.
        },
      ],
      ...(input.specialInstructions
        ? { specialInstructions: [{ value: input.specialInstructions }] }
        : {}),
      remark: `Ship Logger — ${input.parcelCount} DHL parcel(s), ~${input.totalWeightLb} lb total (unweighed estimate)`,
    };

    const res = await fetch(`${apiBase()}/pickups`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
        // Seen as required on DHL's own example requests; not confirmed from
        // docs alone whether it's used for de-duplication server-side.
        "Message-Reference": newId(),
        "Message-Reference-Date": new Date().toISOString(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`DHL pickup request failed: ${res.status}`, body);
      return {
        status: "error",
        message: `DHL pickup request failed: ${res.status}${body ? ` — ${body}` : ""}`,
      };
    }

    const data = (await res.json()) as PickupApiResponse;
    const confirmationNumber = data.dispatchConfirmationNumbers?.[0];
    if (!confirmationNumber) {
      return { status: "error", message: "DHL accepted the request but returned no confirmation number." };
    }
    return { status: "ok", dispatchConfirmationNumber: confirmationNumber };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "DHL pickup request failed.",
    };
  }
}

export type CancelPickupResult = { status: "ok" } | { status: "error"; message: string };

export async function cancelDhlPickup(
  dispatchConfirmationNumber: string,
  requestorName: string,
  reason: string,
): Promise<CancelPickupResult> {
  try {
    const url = new URL(`${apiBase()}/pickups/${encodeURIComponent(dispatchConfirmationNumber)}`);
    url.searchParams.set("requestorName", requestorName);
    url.searchParams.set("reason", reason);

    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      return { status: "error", message: `DHL pickup cancellation failed: ${res.status}` };
    }
    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "DHL pickup cancellation failed.",
    };
  }
}
