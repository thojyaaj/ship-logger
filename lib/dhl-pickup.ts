import "server-only";
import { db } from "./db";
import { dhlPickupSettings, dhlPickupRequest, shipmentSession } from "./db/schema";
import { eq, and, desc } from "drizzle-orm";
import { newId } from "./id";
import {
  nowSqlTimestamp,
  warehouseIsoWithOffset,
  warehouseLocalTime,
  nextCalendarDate,
  localCalendarDate,
} from "./date";
import { requestDhlPickup, cancelDhlPickup } from "./dhl";
import { getShipmentDetail, ShipmentNotFoundError } from "./shiplog";

// One warehouse, one pickup address/account — a fixed-id singleton row
// rather than a keyed settings table.
const SETTINGS_ID = "default";

export type DhlPickupSettings = {
  enabled: boolean;
  accountNumber: string;
  companyName: string;
  contactName: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  readyTime: string;
  closeTime: string;
  avgWeightLbPerParcel: number;
  avgLengthIn: number;
  avgWidthIn: number;
  avgHeightIn: number;
  specialInstructions: string | null;
  updatedAt: string;
};

export async function getDhlPickupSettings(): Promise<DhlPickupSettings | null> {
  const rows = await db
    .select()
    .from(dhlPickupSettings)
    .where(eq(dhlPickupSettings.id, SETTINGS_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.enabled,
    accountNumber: row.accountNumber,
    companyName: row.companyName,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    readyTime: row.readyTime,
    closeTime: row.closeTime,
    avgWeightLbPerParcel: row.avgWeightLbPerParcel,
    avgLengthIn: row.avgLengthIn,
    avgWidthIn: row.avgWidthIn,
    avgHeightIn: row.avgHeightIn,
    specialInstructions: row.specialInstructions,
    updatedAt: row.updatedAt,
  };
}

export type SettingsMutationResult = { status: "ok" } | { status: "error"; message: string };

export type DhlPickupSettingsInput = {
  enabled: boolean;
  accountNumber: string;
  companyName: string;
  contactName: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  readyTime: string;
  closeTime: string;
  avgWeightLbPerParcel: number;
  avgLengthIn: number;
  avgWidthIn: number;
  avgHeightIn: number;
  specialInstructions: string;
};

function isHHMM(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function saveDhlPickupSettings(
  input: DhlPickupSettingsInput,
  updatedBy: string,
): Promise<SettingsMutationResult> {
  const required: [string, string][] = [
    ["Account number", input.accountNumber],
    ["Company name", input.companyName],
    ["Contact name", input.contactName],
    ["Contact phone", input.contactPhone],
    ["Address line 1", input.addressLine1],
    ["City", input.city],
    ["State", input.state],
    ["Postal code", input.postalCode],
    ["Country code", input.countryCode],
  ];
  for (const [label, value] of required) {
    if (!value.trim()) return { status: "error", message: `${label} is required.` };
  }
  if (!isHHMM(input.readyTime)) return { status: "error", message: "Ready time must be in HH:MM format." };
  if (!isHHMM(input.closeTime)) return { status: "error", message: "Close time must be in HH:MM format." };
  if (input.readyTime >= input.closeTime) {
    return { status: "error", message: "Ready time must be before close time." };
  }
  if (!Number.isFinite(input.avgWeightLbPerParcel) || input.avgWeightLbPerParcel <= 0) {
    return { status: "error", message: "Average weight per parcel must be a positive number." };
  }
  const dims: [string, number][] = [
    ["Average length", input.avgLengthIn],
    ["Average width", input.avgWidthIn],
    ["Average height", input.avgHeightIn],
  ];
  for (const [label, value] of dims) {
    if (!Number.isFinite(value) || value <= 0) {
      return { status: "error", message: `${label} must be a positive number.` };
    }
  }

  const now = nowSqlTimestamp();
  await db
    .insert(dhlPickupSettings)
    .values({
      id: SETTINGS_ID,
      enabled: input.enabled,
      accountNumber: input.accountNumber.trim(),
      companyName: input.companyName.trim(),
      contactName: input.contactName.trim(),
      contactPhone: input.contactPhone.trim(),
      addressLine1: input.addressLine1.trim(),
      addressLine2: input.addressLine2.trim() || null,
      city: input.city.trim(),
      state: input.state.trim(),
      postalCode: input.postalCode.trim(),
      countryCode: input.countryCode.trim().toUpperCase(),
      readyTime: input.readyTime,
      closeTime: input.closeTime,
      avgWeightLbPerParcel: input.avgWeightLbPerParcel,
      avgLengthIn: input.avgLengthIn,
      avgWidthIn: input.avgWidthIn,
      avgHeightIn: input.avgHeightIn,
      specialInstructions: input.specialInstructions.trim() || null,
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: dhlPickupSettings.id,
      set: {
        enabled: input.enabled,
        accountNumber: input.accountNumber.trim(),
        companyName: input.companyName.trim(),
        contactName: input.contactName.trim(),
        contactPhone: input.contactPhone.trim(),
        addressLine1: input.addressLine1.trim(),
        addressLine2: input.addressLine2.trim() || null,
        city: input.city.trim(),
        state: input.state.trim(),
        postalCode: input.postalCode.trim(),
        countryCode: input.countryCode.trim().toUpperCase(),
        readyTime: input.readyTime,
        closeTime: input.closeTime,
        avgWeightLbPerParcel: input.avgWeightLbPerParcel,
        avgLengthIn: input.avgLengthIn,
        avgWidthIn: input.avgWidthIn,
        avgHeightIn: input.avgHeightIn,
        specialInstructions: input.specialInstructions.trim() || null,
        updatedAt: now,
        updatedBy,
      },
    });

  return { status: "ok" };
}

export type PickupRequestRecord = {
  id: string;
  status: "requested" | "failed" | "cancelled";
  dispatchConfirmationNumber: string | null;
  parcelCount: number;
  totalWeightLb: number;
  requestedAt: string;
  errorMessage: string | null;
  cancelledAt: string | null;
};

/** Most recent pickup-request attempt for a shipment, if any. */
export async function getLatestPickupRequest(sessionId: string): Promise<PickupRequestRecord | null> {
  const rows = await db
    .select()
    .from(dhlPickupRequest)
    .where(eq(dhlPickupRequest.sessionId, sessionId))
    .orderBy(desc(dhlPickupRequest.requestedAt))
    .limit(1);
  return rows[0] ?? null;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Same-day vs. next-day for a DHL pickup, based on how late the shipment
 * was actually submitted relative to the configured pickup window:
 *
 *  - Submitted at/before (readyTime - 1h): comfortably early — same day.
 *  - Submitted after that but still at/before (closeTime - 3h): missed the
 *    official 1-hour cutoff, but DHL's local dispatcher still has enough
 *    runway before the window closes to fit it in — a grace window, still
 *    same day.
 *  - Submitted after (closeTime - 3h): too late to realistically route a
 *    same-day pickup — next day instead, using the exact same ready/close
 *    times from settings (only the date moves, never the time-of-day
 *    window).
 *
 * "Same day" here always means same day as whichever is later of shipDate
 * and today — a shipment's `shipDate` is set when its session opens and
 * doesn't move if packing runs past midnight, so a shipment opened 8/31 but
 * actually submitted 9/1 still carries shipDate 8/31. Basing the pickup date
 * on that stale shipDate produces a date already in the past, which DHL's
 * API rejects outright ("Pickup date is earlier than the current date") —
 * so the earliest possible pickup day is always today, never earlier.
 */
function resolvePickupDate(
  shipDate: string,
  submittedAt: string | null,
  settings: Pick<DhlPickupSettings, "readyTime" | "closeTime">,
): string {
  // submittedAt is always set by the time a shipment can be submitted (and
  // only a submitted shipment can have a pickup scheduled) — this is just a
  // defensive fallback, not an expected path.
  if (!submittedAt) return shipDate;

  const referenceDate = shipDate < localCalendarDate() ? localCalendarDate() : shipDate;

  const submittedMinutes = hhmmToMinutes(warehouseLocalTime(submittedAt));
  const oneHourBeforeStart = hhmmToMinutes(settings.readyTime) - 60;
  const threeHoursBeforeEnd = hhmmToMinutes(settings.closeTime) - 180;
  const missedFirstCutoff = submittedMinutes > oneHourBeforeStart;
  const withinGraceWindow = submittedMinutes <= threeHoursBeforeEnd;
  const sameDay = !missedFirstCutoff || withinGraceWindow;

  return sameDay ? referenceDate : nextCalendarDate(referenceDate);
}

export type PreviewPickup = {
  parcelCount: number;
  totalWeightLb: number;
  plannedPickupDateAndTime: string;
  closeTime: string;
  address: string;
};

export type PreviewPickupResult = { status: "ok"; preview: PreviewPickup } | { status: "error"; message: string };

/**
 * Computes what a pickup request would contain, without calling DHL — this
 * is what the admin confirmation dialog shows before actually booking.
 */
export async function previewPickupForSession(sessionId: string): Promise<PreviewPickupResult> {
  const settings = await getDhlPickupSettings();
  if (!settings) {
    return { status: "error", message: "DHL pickup settings haven't been configured yet." };
  }
  if (!settings.enabled) {
    return { status: "error", message: "DHL pickup scheduling is currently disabled by an admin." };
  }

  let dashboard;
  try {
    dashboard = await getShipmentDetail(sessionId);
  } catch (err) {
    if (err instanceof ShipmentNotFoundError) return { status: "error", message: "Shipment not found." };
    throw err;
  }

  if (dashboard.session.status !== "submitted") {
    return { status: "error", message: "Only a submitted shipment can have a pickup scheduled." };
  }
  const parcelCount = dashboard.totals.dhl;
  if (parcelCount === 0) {
    return { status: "error", message: "This shipment has no DHL parcels." };
  }

  const totalWeightLb = Math.max(1, Math.round(parcelCount * settings.avgWeightLbPerParcel));
  const pickupDate = resolvePickupDate(dashboard.session.shipDate, dashboard.session.submittedAt, settings);
  return {
    status: "ok",
    preview: {
      parcelCount,
      totalWeightLb,
      plannedPickupDateAndTime: warehouseIsoWithOffset(pickupDate, settings.readyTime),
      closeTime: settings.closeTime,
      address: `${settings.addressLine1}${settings.addressLine2 ? ", " + settings.addressLine2 : ""}, ${settings.city}, ${settings.state} ${settings.postalCode}`,
    },
  };
}

export type SchedulePickupResult =
  | { status: "ok"; dispatchConfirmationNumber: string; parcelCount: number; totalWeightLb: number }
  | { status: "error"; message: string };

export async function schedulePickupForSession(
  sessionId: string,
  requestedBy: string,
): Promise<SchedulePickupResult> {
  const settings = await getDhlPickupSettings();
  if (!settings) {
    return { status: "error", message: "DHL pickup settings haven't been configured yet." };
  }
  if (!settings.enabled) {
    return { status: "error", message: "DHL pickup scheduling is currently disabled by an admin." };
  }

  const session = (
    await db.select().from(shipmentSession).where(eq(shipmentSession.id, sessionId))
  )[0];
  if (!session) return { status: "error", message: "Shipment not found." };
  if (session.status !== "submitted") {
    return { status: "error", message: "Only a submitted shipment can have a pickup scheduled." };
  }

  // Guard against double-booking: DHL's own docs note that cancelling a
  // pickup cancels the whole consolidated pickup, not just this shipment, so
  // two live requests for the same shipment is a real mess to untangle by
  // hand. The unique index on (session_id) WHERE status='requested' enforces
  // this at the DB layer too — this check exists to fail with a clear message
  // instead of a raw constraint-violation error.
  const active = await db
    .select()
    .from(dhlPickupRequest)
    .where(and(eq(dhlPickupRequest.sessionId, sessionId), eq(dhlPickupRequest.status, "requested")));
  if (active[0]) {
    return {
      status: "error",
      message: `A pickup is already scheduled for this shipment (confirmation ${active[0].dispatchConfirmationNumber}). Cancel it first to rebook.`,
    };
  }

  const dashboard = await getShipmentDetail(sessionId);
  const parcelCount = dashboard.totals.dhl;
  if (parcelCount === 0) {
    return { status: "error", message: "This shipment has no DHL parcels." };
  }
  const totalWeightLb = Math.max(1, Math.round(parcelCount * settings.avgWeightLbPerParcel));
  const pickupDate = resolvePickupDate(session.shipDate, session.submittedAt, settings);

  const result = await requestDhlPickup({
    accountNumber: settings.accountNumber,
    plannedPickupDateAndTime: warehouseIsoWithOffset(pickupDate, settings.readyTime),
    closeTime: settings.closeTime,
    companyName: settings.companyName,
    contactName: settings.contactName,
    contactPhone: settings.contactPhone,
    address: {
      addressLine1: settings.addressLine1,
      addressLine2: settings.addressLine2 ?? undefined,
      city: settings.city,
      state: settings.state,
      postalCode: settings.postalCode,
      countryCode: settings.countryCode,
    },
    parcelCount,
    totalWeightLb,
    dimensions: {
      length: settings.avgLengthIn,
      width: settings.avgWidthIn,
      height: settings.avgHeightIn,
    },
    specialInstructions: settings.specialInstructions ?? undefined,
  });

  const id = newId();
  const requestedAt = nowSqlTimestamp();

  if (result.status === "ok") {
    try {
      await db.insert(dhlPickupRequest).values({
        id,
        sessionId,
        requestedBy,
        requestedAt,
        status: "requested",
        dispatchConfirmationNumber: result.dispatchConfirmationNumber,
        parcelCount,
        totalWeightLb,
        errorMessage: null,
      });
    } catch (err) {
      // The unique index rejected a concurrent duplicate that slipped past
      // the check above (two admins clicking at once) — DHL has already
      // booked a real truck at this point, so this must not be swallowed
      // silently. Surface it as a mismatch to investigate by hand rather
      // than losing the confirmation number.
      return {
        status: "error",
        message: `DHL confirmed pickup ${result.dispatchConfirmationNumber}, but a concurrent request already recorded one for this shipment — check both before proceeding. (${err instanceof Error ? err.message : "unknown error"})`,
      };
    }
    return {
      status: "ok",
      dispatchConfirmationNumber: result.dispatchConfirmationNumber,
      parcelCount,
      totalWeightLb,
    };
  }

  await db.insert(dhlPickupRequest).values({
    id,
    sessionId,
    requestedBy,
    requestedAt,
    status: "failed",
    dispatchConfirmationNumber: null,
    parcelCount,
    totalWeightLb,
    errorMessage: result.message,
  });
  return { status: "error", message: result.message };
}

export type CancelPickupResult = { status: "ok" } | { status: "error"; message: string };

export async function cancelPickupForSession(
  sessionId: string,
  cancelledByUserId: string,
  cancelledByName: string,
): Promise<CancelPickupResult> {
  const active = (
    await db
      .select()
      .from(dhlPickupRequest)
      .where(and(eq(dhlPickupRequest.sessionId, sessionId), eq(dhlPickupRequest.status, "requested")))
  )[0];
  if (!active || !active.dispatchConfirmationNumber) {
    return { status: "error", message: "No active pickup to cancel for this shipment." };
  }

  const result = await cancelDhlPickup(
    active.dispatchConfirmationNumber,
    cancelledByName,
    "Cancelled by warehouse staff via Ship Logger",
  );
  if (result.status === "error") return result;

  await db
    .update(dhlPickupRequest)
    .set({ status: "cancelled", cancelledAt: nowSqlTimestamp(), cancelledBy: cancelledByUserId })
    .where(eq(dhlPickupRequest.id, active.id));
  return { status: "ok" };
}
