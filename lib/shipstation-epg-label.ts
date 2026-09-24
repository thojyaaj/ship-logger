import "server-only";
import { db } from "./db";
import { shipstationEpgLabelSettings, shipmentSession, box } from "./db/schema";
import { eq } from "drizzle-orm";
import { nowSqlTimestamp } from "./date";

/**
 * Drafts (never purchases) the single ShipStation shipment that covers
 * every EPG box in a session as a UPS multi-piece shipment — one `package`
 * entry per box, one master tracking number covering all of them, matching
 * how UPS multi-piece actually works and how docs/PRD.md's data model
 * expects `shipmentSession.masterUpsTracking` to behave (§7: "ONE UPS
 * master; accounts for every box").
 *
 * This only pre-fills ShipStation — a person still has to open the
 * shipment there, weigh each box, and buy the label. `syncMasterUpsTracking`
 * below is what closes the loop: once bought, it looks the resulting label
 * up and writes its tracking number back as this session's
 * masterUpsTracking, which is what the AWB depends on and what unblocks
 * Submit (see SubmitDialog.tsx and lib/shiplog.ts's submitSession).
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
 * recorded on the session row (shipstationDraftStatus: "error") rather than
 * blocking anything — the packer can always fall back to creating the label
 * by hand in ShipStation and typing the AWB/master tracking in directly.
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

/** Creates (POST) then fills in carrier/service/billing (PUT) one ShipStation shipment with `packageCount` packages — one per EPG box. Never throws. */
async function createDraftShipment(
  settings: ShipstationEpgLabelSettings,
  packageCount: number,
): Promise<DraftShipmentResult> {
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
  // One package per EPG box — this is what makes it a UPS *multi-piece*
  // shipment (one master tracking covering every piece) rather than
  // packageCount separate shipments with unrelated tracking numbers.
  const packages = Array.from({ length: Math.max(1, packageCount) }, () => ({
    package_code: "package",
    weight: { value: PLACEHOLDER_WEIGHT_LB, unit: "pound" },
    dimensions: {
      unit: "inch",
      length: settings.packageLengthIn,
      width: settings.packageWidthIn,
      height: settings.packageHeightIn,
    },
  }));

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

export type SessionDraftState = {
  shipstationShipmentId: string | null;
  shipstationDraftStatus: "created" | "error" | null;
  shipstationDraftError: string | null;
};

/**
 * Drafts (never purchases) this session's single multi-piece ShipStation
 * shipment, one package per EPG box — called when a packer opens the close-
 * out step for a shipment with EPG parcels and no masterUpsTracking yet
 * (see SubmitDialog.tsx). Idempotent: if the session already has a
 * shipstationShipmentId, returns it as-is rather than creating a second
 * shipment — this is safe to call on every dialog open/retry.
 */
export async function draftSessionShipment(sessionId: string): Promise<SessionDraftState> {
  const sessionRows = await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)).limit(1);
  const session = sessionRows[0];
  if (!session) {
    return { shipstationShipmentId: null, shipstationDraftStatus: "error", shipstationDraftError: "Session not found." };
  }
  if (session.shipstationShipmentId) {
    return {
      shipstationShipmentId: session.shipstationShipmentId,
      shipstationDraftStatus: session.shipstationDraftStatus,
      shipstationDraftError: session.shipstationDraftError,
    };
  }

  const settings = await getShipstationEpgLabelSettings();
  if (!settings?.enabled) {
    const message = settings ? "ShipStation EPG label drafting is turned off." : "ShipStation EPG label settings aren't configured yet.";
    await db
      .update(shipmentSession)
      .set({ shipstationDraftStatus: "error", shipstationDraftError: message, shipstationDraftAt: nowSqlTimestamp() })
      .where(eq(shipmentSession.id, sessionId));
    return { shipstationShipmentId: null, shipstationDraftStatus: "error", shipstationDraftError: message };
  }

  const boxCount = (await db.select().from(box).where(eq(box.sessionId, sessionId))).length;
  console.log(`[shipstation-epg-label] drafting ShipStation shipment for session ${sessionId} (${boxCount} box(es))`);
  const result = await createDraftShipment(settings, boxCount);

  if (result.status === "ok") {
    console.log(`[shipstation-epg-label] session ${sessionId} -> shipment ${result.shipmentId}`);
    await db
      .update(shipmentSession)
      .set({
        shipstationShipmentId: result.shipmentId,
        shipstationDraftStatus: "created",
        shipstationDraftError: null,
        shipstationDraftAt: nowSqlTimestamp(),
      })
      .where(eq(shipmentSession.id, sessionId));
    return { shipstationShipmentId: result.shipmentId, shipstationDraftStatus: "created", shipstationDraftError: null };
  }

  console.error(`[shipstation-epg-label] session ${sessionId} draft failed: ${result.message}`);
  await db
    .update(shipmentSession)
    .set({ shipstationDraftStatus: "error", shipstationDraftError: result.message, shipstationDraftAt: nowSqlTimestamp() })
    .where(eq(shipmentSession.id, sessionId));
  return { shipstationShipmentId: null, shipstationDraftStatus: "error", shipstationDraftError: result.message };
}

type LabelListResponse = {
  labels?: { tracking_number?: string; created_at?: string }[];
};

export type SyncMasterTrackingResult =
  | { status: "ok"; masterUpsTracking: string }
  | { status: "pending" } // drafted (or not yet drafted), but no purchased label found yet
  | { status: "error"; message: string };

/**
 * Looks up whether this session's drafted shipment has a purchased label
 * yet, and if so writes its tracking number in as masterUpsTracking —
 * called on a client-side poll from SubmitDialog.tsx while a packer is
 * between "opened ShipStation to buy the label" and "label bought." No-ops
 * (returns "ok" immediately) if masterUpsTracking is already set, so a late
 * poll response after the packer already closed the loop is harmless.
 *
 * UNVERIFIED ASSUMPTION, same posture as lib/shipstation.ts's own
 * unverified endpoints: ShipStation's v2 API has no explicit "master
 * tracking number" concept for a multi-package shipment (confirmed absent
 * from the v2 OpenAPI spec) — buying a label for a multi-piece shipment is
 * expected to produce one label per package, each with its own
 * tracking_number, following UPS's own convention that the first piece's
 * tracking number is the one that acts as the master. This takes the
 * earliest-created completed label for the shipment as the master. Confirm
 * this against a real multi-piece UPS purchase before trusting it blindly;
 * if it's wrong, the fallback (typing AWB/master tracking in by hand) is
 * always available in SubmitDialog.
 */
export async function syncMasterUpsTracking(sessionId: string): Promise<SyncMasterTrackingResult> {
  const sessionRows = await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId)).limit(1);
  const session = sessionRows[0];
  if (!session) return { status: "error", message: "Session not found." };
  if (session.masterUpsTracking) return { status: "ok", masterUpsTracking: session.masterUpsTracking };
  if (!session.shipstationShipmentId) return { status: "pending" };

  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) return { status: "error", message: "SHIPSTATION_API_KEY not set." };

  try {
    const url = new URL(`${apiBase()}/labels`);
    url.searchParams.set("shipment_id", session.shipstationShipmentId);
    url.searchParams.set("label_status", "completed");
    url.searchParams.set("sort_by", "created_at");
    url.searchParams.set("sort_dir", "asc");
    url.searchParams.set("page_size", "25");

    const res = await fetch(url, { headers: { "API-Key": apiKey }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error(`[shipstation-epg-label] sync GET /labels failed: ${res.status} ${res.statusText}`);
      return { status: "error", message: `ShipStation lookup failed (${res.status}).` };
    }

    const data = (await res.json()) as LabelListResponse;
    const earliest = data.labels?.[0];
    if (!earliest?.tracking_number) return { status: "pending" };

    await db
      .update(shipmentSession)
      .set({ masterUpsTracking: earliest.tracking_number })
      .where(eq(shipmentSession.id, sessionId));
    console.log(`[shipstation-epg-label] session ${sessionId} synced masterUpsTracking = ${earliest.tracking_number}`);
    return { status: "ok", masterUpsTracking: earliest.tracking_number };
  } catch (err) {
    console.error("[shipstation-epg-label] sync threw:", err);
    return { status: "error", message: err instanceof Error ? err.message : "Unknown error." };
  }
}
