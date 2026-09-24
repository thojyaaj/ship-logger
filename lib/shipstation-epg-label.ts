import "server-only";
import { db } from "./db";
import { shipstationEpgLabelSettings, box } from "./db/schema";
import { eq } from "drizzle-orm";
import { nowSqlTimestamp } from "./date";

/**
 * Auto-drafts the UPS shipment ShipStation needs for an EPG box's outbound
 * label to ePost Global's hub — created (not purchased) the moment a
 * shipment with EPG parcels is submitted, so all a packer/admin has to do
 * in ShipStation afterward is weigh the box and click Buy Label. Every
 * field here except weight (unknown until the box is on a scale) comes
 * straight from shipstation_epg_label_settings.
 *
 * Two-call sequence, per ShipStation v2's own split: POST /v2/shipments
 * creates the shipment but its request body has no carrier_id/service_code/
 * confirmation/advanced_options fields (confirmed against the v2 OpenAPI
 * spec — create_shipment_request rejects unknown properties). Those live on
 * PUT /v2/shipments/{id} ("Use this endpoint to modify shipment information
 * before purchasing a label"), so every draft is create-then-update.
 *
 * Failure posture matches every other carrier client in this app
 * (lib/shipstation.ts, lib/dhl-pickup.ts): never throws. A failure is
 * recorded on the box row (shipstationDraftStatus: "error") rather than
 * blocking or retrying the submit that triggered it — submitting today's
 * shipment must never hinge on ShipStation being reachable.
 */

const PROD_BASE = "https://api.shipstation.com/v2";

function apiBase(): string {
  return process.env.SHIPSTATION_API_BASE ?? PROD_BASE;
}

const SETTINGS_ID = "default";

export type ShipstationEpgLabelSettings = {
  enabled: boolean;
  shipToName: string;
  shipToCompanyName: string;
  shipToAddressLine1: string;
  shipToAddressLine2: string | null;
  shipToCity: string;
  shipToState: string;
  shipToPostalCode: string;
  shipToCountryCode: string;
  shipToPhone: string;
  shipFromWarehouseName: string;
  serviceCode: string;
  confirmation: string;
  billToParty: "recipient" | "third_party";
  billToAccount: string;
  billToPostalCode: string;
  billToCountryCode: string;
  packageLengthIn: number;
  packageWidthIn: number;
  packageHeightIn: number;
  updatedAt: string;
};

export async function getShipstationEpgLabelSettings(): Promise<ShipstationEpgLabelSettings | null> {
  const rows = await db
    .select()
    .from(shipstationEpgLabelSettings)
    .where(eq(shipstationEpgLabelSettings.id, SETTINGS_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.enabled,
    shipToName: row.shipToName,
    shipToCompanyName: row.shipToCompanyName,
    shipToAddressLine1: row.shipToAddressLine1,
    shipToAddressLine2: row.shipToAddressLine2,
    shipToCity: row.shipToCity,
    shipToState: row.shipToState,
    shipToPostalCode: row.shipToPostalCode,
    shipToCountryCode: row.shipToCountryCode,
    shipToPhone: row.shipToPhone,
    shipFromWarehouseName: row.shipFromWarehouseName,
    serviceCode: row.serviceCode,
    confirmation: row.confirmation,
    billToParty: row.billToParty as "recipient" | "third_party",
    billToAccount: row.billToAccount,
    billToPostalCode: row.billToPostalCode,
    billToCountryCode: row.billToCountryCode,
    packageLengthIn: row.packageLengthIn,
    packageWidthIn: row.packageWidthIn,
    packageHeightIn: row.packageHeightIn,
    updatedAt: row.updatedAt,
  };
}

export type ShipstationEpgLabelSettingsInput = Omit<ShipstationEpgLabelSettings, "updatedAt">;

export type SettingsMutationResult = { status: "ok" } | { status: "error"; message: string };

export async function saveShipstationEpgLabelSettings(
  input: ShipstationEpgLabelSettingsInput,
  updatedBy: string,
): Promise<SettingsMutationResult> {
  const required: [string, string][] = [
    ["Ship-to name", input.shipToName],
    ["Ship-to address line 1", input.shipToAddressLine1],
    ["Ship-to city", input.shipToCity],
    ["Ship-to state", input.shipToState],
    ["Ship-to postal code", input.shipToPostalCode],
    ["Ship-to country code", input.shipToCountryCode],
    ["Ship-to phone", input.shipToPhone],
    ["Ship-from warehouse name", input.shipFromWarehouseName],
    ["Service code", input.serviceCode],
    ["Billing account number", input.billToAccount],
    ["Billing postal code", input.billToPostalCode],
    ["Billing country code", input.billToCountryCode],
  ];
  for (const [label, value] of required) {
    if (!value.trim()) return { status: "error", message: `${label} is required.` };
  }
  if (input.packageLengthIn <= 0 || input.packageWidthIn <= 0 || input.packageHeightIn <= 0) {
    return { status: "error", message: "Package dimensions must be greater than zero." };
  }

  await db
    .insert(shipstationEpgLabelSettings)
    .values({
      id: SETTINGS_ID,
      ...input,
      shipToAddressLine2: input.shipToAddressLine2?.trim() || null,
      updatedAt: nowSqlTimestamp(),
      updatedBy,
    })
    .onConflictDoUpdate({
      target: shipstationEpgLabelSettings.id,
      set: {
        ...input,
        shipToAddressLine2: input.shipToAddressLine2?.trim() || null,
        updatedAt: nowSqlTimestamp(),
        updatedBy,
      },
    });

  return { status: "ok" };
}

// A draft shipment needs *some* weight > 0 (ShipStation's `weight.value` is
// exclusiveMinimum: 0) even though the real box weight isn't known until a
// person puts it on a scale — this placeholder exists only to satisfy that
// constraint and is expected to be overwritten in ShipStation before the
// label is bought.
const PLACEHOLDER_WEIGHT_LB = 1;

type CarrierListResponse = { carriers?: { carrier_id?: string; carrier_code?: string }[] };
type WarehouseListResponse = { warehouses?: { warehouse_id?: string; name?: string }[] };

let cachedUpsCarrierId: string | null | undefined;
const cachedWarehouseIds = new Map<string, string | null>();

async function ssFetch(apiKey: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { "API-Key": apiKey, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
}

/** Finds the connected UPS carrier account's se-xxxxx id. Cached for the life of this process — carrier connections don't change mid-deploy. */
async function resolveUpsCarrierId(apiKey: string): Promise<string | null> {
  if (cachedUpsCarrierId !== undefined) return cachedUpsCarrierId;
  const res = await ssFetch(apiKey, "/carriers");
  if (!res.ok) {
    console.error(`[shipstation-epg-label] GET /carriers failed: ${res.status} ${res.statusText}`);
    return null;
  }
  const data = (await res.json()) as CarrierListResponse;
  const ups = data.carriers?.find((c) => c.carrier_code === "ups");
  cachedUpsCarrierId = ups?.carrier_id ?? null;
  if (!cachedUpsCarrierId) {
    console.error("[shipstation-epg-label] no connected UPS carrier found in this ShipStation account");
  }
  return cachedUpsCarrierId;
}

/** Finds a warehouse's se-xxxxx id by (case-insensitive) name. Cached per name for the life of this process. */
async function resolveWarehouseId(apiKey: string, name: string): Promise<string | null> {
  if (cachedWarehouseIds.has(name)) return cachedWarehouseIds.get(name)!;
  const res = await ssFetch(apiKey, "/warehouses");
  if (!res.ok) {
    console.error(`[shipstation-epg-label] GET /warehouses failed: ${res.status} ${res.statusText}`);
    return null;
  }
  const data = (await res.json()) as WarehouseListResponse;
  const match = data.warehouses?.find((w) => w.name?.trim().toLowerCase() === name.trim().toLowerCase());
  const id = match?.warehouse_id ?? null;
  cachedWarehouseIds.set(name, id);
  if (!id) {
    console.error(`[shipstation-epg-label] no ShipStation warehouse named "${name}" found`);
  }
  return id;
}

export type DraftShipmentResult =
  | { status: "ok"; shipmentId: string }
  | { status: "error"; message: string };

/** Creates (POST) then fills in carrier/service/billing (PUT) the ShipStation shipment for one EPG box. Never throws. */
async function createDraftShipment(settings: ShipstationEpgLabelSettings): Promise<DraftShipmentResult> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) return { status: "error", message: "SHIPSTATION_API_KEY not set." };

  const [carrierId, warehouseId] = await Promise.all([
    resolveUpsCarrierId(apiKey),
    resolveWarehouseId(apiKey, settings.shipFromWarehouseName),
  ]);
  if (!carrierId) return { status: "error", message: "No connected UPS carrier found in ShipStation." };
  if (!warehouseId) {
    return { status: "error", message: `No ShipStation warehouse named "${settings.shipFromWarehouseName}".` };
  }

  const shipTo = {
    name: settings.shipToName,
    company_name: settings.shipToCompanyName || null,
    phone: settings.shipToPhone,
    address_line1: settings.shipToAddressLine1,
    address_line2: settings.shipToAddressLine2 || null,
    city_locality: settings.shipToCity,
    state_province: settings.shipToState,
    postal_code: settings.shipToPostalCode,
    country_code: settings.shipToCountryCode,
    address_residential_indicator: "no",
  };
  const packages = [
    {
      package_code: "package",
      weight: { value: PLACEHOLDER_WEIGHT_LB, unit: "pound" },
      dimensions: {
        unit: "inch",
        length: settings.packageLengthIn,
        width: settings.packageWidthIn,
        height: settings.packageHeightIn,
      },
    },
  ];

  try {
    const createRes = await ssFetch(apiKey, "/shipments", {
      method: "POST",
      body: JSON.stringify({ shipments: [{ ship_to: shipTo, warehouse_id: warehouseId, packages }] }),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      console.error(`[shipstation-epg-label] POST /shipments failed: ${createRes.status} ${body.slice(0, 500)}`);
      return { status: "error", message: `ShipStation create failed (${createRes.status}).` };
    }
    const created = (await createRes.json()) as {
      has_errors?: boolean;
      shipments?: { shipment_id?: string; errors?: { message?: string }[] }[];
    };
    const shipment = created.shipments?.[0];
    if (created.has_errors || !shipment?.shipment_id) {
      const message = shipment?.errors?.[0]?.message ?? "ShipStation returned no shipment_id.";
      console.error(`[shipstation-epg-label] shipment creation had errors: ${message}`);
      return { status: "error", message };
    }
    const shipmentId = shipment.shipment_id;

    const updateRes = await ssFetch(apiKey, `/shipments/${encodeURIComponent(shipmentId)}`, {
      method: "PUT",
      body: JSON.stringify({
        ship_to: shipTo,
        warehouse_id: warehouseId,
        packages,
        carrier_id: carrierId,
        service_code: settings.serviceCode,
        confirmation: settings.confirmation,
        advanced_options: {
          bill_to_party: settings.billToParty,
          bill_to_account: settings.billToAccount,
          bill_to_country_code: settings.billToCountryCode,
          bill_to_postal_code: settings.billToPostalCode,
        },
      }),
    });
    if (!updateRes.ok) {
      const body = await updateRes.text();
      console.error(`[shipstation-epg-label] PUT /shipments/${shipmentId} failed: ${updateRes.status} ${body.slice(0, 500)}`);
      // The shipment exists (create succeeded) but wasn't fully configured —
      // still report the id so it's not orphaned, with an error alongside so
      // it's clear the service/billing fields need to be set by hand.
      return { status: "error", message: `Shipment ${shipmentId} created but options failed to apply.` };
    }

    return { status: "ok", shipmentId };
  } catch (err) {
    console.error("[shipstation-epg-label] draft creation threw:", err);
    return { status: "error", message: err instanceof Error ? err.message : "Unknown error." };
  }
}

/**
 * Drafts (never purchases) the ShipStation shipment for every EPG box in a
 * just-submitted session that doesn't already have one — called from
 * submitSession's `after()` (lib/shiplog.ts), so a slow or unreachable
 * ShipStation can never delay the submit response a packer is waiting on.
 * Idempotent: a retry (e.g. after a prior partial failure) skips any box
 * that already has a shipstationShipmentId rather than creating a duplicate.
 */
export async function createEpgDraftShipmentsForSession(sessionId: string): Promise<void> {
  const settings = await getShipstationEpgLabelSettings();
  if (!settings?.enabled) return;

  const boxRows = await db
    .select()
    .from(box)
    .where(eq(box.sessionId, sessionId));

  for (const row of boxRows) {
    if (row.shipstationShipmentId) continue; // already drafted
    console.log(`[shipstation-epg-label] drafting ShipStation shipment for box ${row.id} (session ${sessionId})`);
    const result = await createDraftShipment(settings);
    if (result.status === "ok") {
      console.log(`[shipstation-epg-label] box ${row.id} -> shipment ${result.shipmentId}`);
      await db
        .update(box)
        .set({
          shipstationShipmentId: result.shipmentId,
          shipstationDraftStatus: "created",
          shipstationDraftError: null,
          shipstationDraftAt: nowSqlTimestamp(),
        })
        .where(eq(box.id, row.id));
    } else {
      console.error(`[shipstation-epg-label] box ${row.id} draft failed: ${result.message}`);
      await db
        .update(box)
        .set({
          shipstationDraftStatus: "error",
          shipstationDraftError: result.message,
          shipstationDraftAt: nowSqlTimestamp(),
        })
        .where(eq(box.id, row.id));
    }
  }
}
