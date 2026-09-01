import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  real,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Timestamp columns are `text`, not Postgres's native `timestamp` type,
// formatted as "YYYY-MM-DD HH:MI:SS" UTC with no zone marker — matching
// what SQLite's `(current_timestamp)` produced during Phase 1 dev. Kept
// this way on the Postgres port so lib/date.ts's parsing (and every
// display site built against it) didn't need to change.
const nowUtcText = sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

export const appUser = pgTable("app_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  pinHash: text("pin_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at").notNull().default(nowUtcText),
});

export const shipmentSession = pgTable(
  "shipment_session",
  {
    id: text("id").primaryKey(),
    openedAt: text("opened_at").notNull().default(nowUtcText),
    openedBy: text("opened_by")
      .notNull()
      .references(() => appUser.id),
    submittedAt: text("submitted_at"),
    submittedBy: text("submitted_by").references(() => appUser.id),
    shipDate: text("ship_date").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: ["open", "submitted", "voided"] })
      .notNull()
      .default("open"),
    awbNumber: text("awb_number"),
    masterUpsTracking: text("master_ups_tracking"),
    // Live UPS Track API status for `masterUpsTracking`, refreshed by the
    // nightly ups-status cron (mirrors scan.status_* for EPG). Nullable/never
    // populated until the cron runs at least once for this session.
    masterUpsStatusCode: text("master_ups_status_code"),
    masterUpsStatusLabel: text("master_ups_status_label"),
    masterUpsStatusAt: text("master_ups_status_at"),
    masterUpsStatusCheckedAt: text("master_ups_status_checked_at"),
    // Which EPG box new scans land in. UI-convenience state, not domain data —
    // kept here (rather than only in client state) so a hard refresh mid-session
    // reopens on the same box instead of defaulting back to Box 1.
    activeBoxId: text("active_box_id"),
  },
  // At most one row can be "open" at a time — that's what makes "the open
  // session" unambiguous. A partial unique index on `status` (filtered to
  // just the 'open' rows) enforces this at the database level: a second
  // concurrent INSERT racing to open a session fails with a unique
  // violation instead of silently creating two open sessions. See
  // getOrCreateOpenSession's retry-on-conflict handling in lib/shiplog.ts.
  (t) => [uniqueIndex("shipment_session_one_open_idx").on(t.status).where(sql`${t.status} = 'open'`)],
);

export const box = pgTable(
  "box",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => shipmentSession.id),
    boxNumber: integer("box_number").notNull(),
    upsTracking: text("ups_tracking"),
  },
  (t) => [uniqueIndex("box_session_number_idx").on(t.sessionId, t.boxNumber)],
);

export const scan = pgTable(
  "scan",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => shipmentSession.id),
    boxId: text("box_id").references(() => box.id),
    scannedBy: text("scanned_by")
      .notNull()
      .references(() => appUser.id),
    trackingNumber: text("tracking_number").notNull(),
    carrier: text("carrier", { enum: ["epg", "ups", "dhl", "unknown"] }).notNull(),
    scannedAt: text("scanned_at").notNull().default(nowUtcText),
    sequence: integer("sequence").notNull(),
    orderGid: text("order_gid"),
    orderName: text("order_name"),
    epgExternalRef: text("epg_external_ref"),
    epgFinalMile: text("epg_final_mile"),
    statusCode: text("status_code"),
    statusLabel: text("status_label"),
    statusAt: text("status_at"),
    statusCheckedAt: text("status_checked_at"),
  },
  (t) => [uniqueIndex("scan_tracking_number_idx").on(t.trackingNumber)],
);

// Phase 2 §9b — UPS/DHL parcels carry no reference back to their Shopify
// order (unlike EPG's ERef), so this index is fed by FULFILLMENTS_CREATE/
// UPDATE webhooks plus a one-time backfill, then read locally at scan time
// with no per-scan Shopify API call. EPG parcels don't use this table —
// their order comes from resolving `scan.epg_external_ref` (ERef) via a
// live Shopify query in the nightly EPG status cron (§9a).
export const shopifyOrderIndex = pgTable("shopify_order_index", {
  trackingNumber: text("tracking_number").primaryKey(),
  orderGid: text("order_gid").notNull(),
  orderName: text("order_name").notNull(),
  customerName: text("customer_name"),
  destination: text("destination"),
  updatedAt: text("updated_at").notNull().default(nowUtcText),
});

// Single settings row for DHL Express pickup scheduling — one warehouse, one
// pickup address/account, so a fixed-id singleton rather than a keyed table
// (see lib/dhl-pickup.ts's SETTINGS_ID). Deliberately does NOT hold API
// credentials: DHL_CLIENT_ID/DHL_CLIENT_SECRET are real secrets and follow
// this app's existing env-var-only convention (UPS_CLIENT_ID/SECRET,
// SHOPIFY_CLIENT_ID/SECRET) — nothing here is sensitive enough to need that,
// it's business configuration an admin should be able to edit without a
// redeploy.
export const dhlPickupSettings = pgTable("dhl_pickup_settings", {
  id: text("id").primaryKey(),
  accountNumber: text("account_number").notNull(),
  // DHL's pickup API rejects shipperDetails.contactInformation without a
  // companyName — a real DHL Express account is registered to a business,
  // not an individual, so this is required alongside contactName/Phone.
  // Default only exists so the migration doesn't fail against the existing
  // settings row — every write from saveDhlPickupSettings requires a real
  // value going forward (see the `required` list in lib/dhl-pickup.ts).
  companyName: text("company_name").notNull().default("OTC Shoppe Express"),
  contactName: text("contact_name").notNull(),
  contactPhone: text("contact_phone").notNull(),
  addressLine1: text("address_line1").notNull(),
  addressLine2: text("address_line2"),
  city: text("city").notNull(),
  state: text("state").notNull(),
  postalCode: text("postal_code").notNull(),
  countryCode: text("country_code").notNull().default("US"),
  readyTime: text("ready_time").notNull(), // "HH:MM", warehouse-local
  closeTime: text("close_time").notNull(), // "HH:MM", warehouse-local
  // We don't weigh individual packages — DHL's pickup request wants a total
  // weight, so this is a per-parcel estimate multiplied by the day's DHL
  // parcel count. Editable, not hardcoded, since that average is a business
  // assumption that may need adjusting later.
  avgWeightLbPerParcel: real("avg_weight_lb_per_parcel").notNull().default(1),
  // Same reasoning as avgWeightLbPerParcel: DHL's pickup API also requires a
  // package dimensions block, and parcels aren't individually measured, so
  // this is an editable average-box-size estimate in inches.
  avgLengthIn: real("avg_length_in").notNull().default(12),
  avgWidthIn: real("avg_width_in").notNull().default(12),
  avgHeightIn: real("avg_height_in").notNull().default(12),
  specialInstructions: text("special_instructions"),
  updatedAt: text("updated_at").notNull().default(nowUtcText),
  updatedBy: text("updated_by").references(() => appUser.id),
});

// One row per DHL pickup request attempt against a submitted shipment.
// Deliberately NOT part of shipment_session — a shipment can accumulate
// multiple rows across retries (a failed attempt, then a successful one; a
// successful one, then cancelled and re-requested), and this keeps that
// history instead of overwriting it.
export const dhlPickupRequest = pgTable(
  "dhl_pickup_request",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => shipmentSession.id),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => appUser.id),
    requestedAt: text("requested_at").notNull().default(nowUtcText),
    status: text("status", { enum: ["requested", "failed", "cancelled"] }).notNull(),
    dispatchConfirmationNumber: text("dispatch_confirmation_number"),
    parcelCount: integer("parcel_count").notNull(),
    totalWeightLb: real("total_weight_lb").notNull(),
    errorMessage: text("error_message"),
    cancelledAt: text("cancelled_at"),
    cancelledBy: text("cancelled_by").references(() => appUser.id),
  },
  // At most one *active* (successfully booked, not yet cancelled) pickup per
  // shipment — DHL's own docs note that cancelling a pickup cancels the whole
  // consolidated pickup, not one shipment within it, so silently allowing two
  // live bookings for the same shipment would be a real, hard-to-untangle
  // mistake. A failed attempt or a cancelled one doesn't hold this lock, so
  // retrying after either is unaffected.
  (t) => [
    uniqueIndex("dhl_pickup_request_one_active_idx")
      .on(t.sessionId)
      .where(sql`${t.status} = 'requested'`),
  ],
);
