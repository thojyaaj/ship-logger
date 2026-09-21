import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  real,
  index,
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
  // Two-digit ("00"-"99") crew code, assigned once at creation (see
  // lib/users.ts's addUser) and never reassigned. Affixed to a session's
  // short ID ("<id>-<code>") on the shipment detail page and shipment log
  // as a compact, at-a-glance record of who submitted it — cheaper to scan
  // than a name badge, and doesn't need its own line the way "Submitted by
  // <name>" did.
  packerCode: text("packer_code").unique(),
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
    // Soft-delete: set when an admin deletes a submitted shipment from the
    // UI. The row (and its scans/boxes) stay in place — trashed shipments
    // are just filtered out of the normal shipments list — so a mistaken
    // delete can be restored from the Trash page. Only cleared by
    // restoreShipment, or turned into a real DELETE by the 30-day purge cron.
    deletedAt: text("deleted_at"),
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
    // 2-letter (Shopify's countryCodeV2) — carried through the same
    // order-matching paths as orderGid/orderName above (see lib/shiplog.ts's
    // recordScan, lib/order-index.ts's upsertOrderIndex, and
    // lib/epg-cron.ts's ERef resolution), never looked up separately.
    destinationCountry: text("destination_country"),
    // What the customer was originally charged for shipping on the matched
    // order — carried through the same three order-matching paths as
    // destinationCountry above. Compared against shipstationCostAmount
    // below to flag a shipping loss (see lib/shipment-alerts.ts).
    customerShippingAmount: real("customer_shipping_amount"),
    customerShippingCurrency: text("customer_shipping_currency"),
    epgExternalRef: text("epg_external_ref"),
    epgFinalMile: text("epg_final_mile"),
    statusCode: text("status_code"),
    statusLabel: text("status_label"),
    statusAt: text("status_at"),
    statusCheckedAt: text("status_checked_at"),
    // Real per-parcel weight/dimensions/cost as captured by ShipStation at
    // label creation, backfilled for every carrier by the shipstation-labels
    // cron (every EPG/UPS/DHL label ships through it) — weight/dims feed the
    // DHL pickup calculation (lib/dhl-pickup.ts), cost feeds the cost
    // analytics in lib/analytics.ts. Written together or not at all, so
    // `shipstationWeightLb IS NULL` is a reliable "not yet backfilled" signal.
    shipstationWeightLb: real("shipstation_weight_lb"),
    shipstationLengthIn: real("shipstation_length_in"),
    shipstationWidthIn: real("shipstation_width_in"),
    shipstationHeightIn: real("shipstation_height_in"),
    // Nullable independent of the four above — a label can come back with no
    // cost (e.g. a void), which shouldn't be treated as "not yet backfilled".
    shipstationCostAmount: real("shipstation_cost_amount"),
    shipstationCostCurrency: text("shipstation_cost_currency"),
    // ShipStation's own carrier code for this label (e.g. "ups") — feeds
    // lib/shipstation-delivery-cron.ts's tracking lookup so it never has to
    // guess a mapping from this app's own epg/ups/dhl carrier enum.
    shipstationCarrierCode: text("shipstation_carrier_code"),
    shipstationCheckedAt: text("shipstation_checked_at"),
    // Order-match fallback (lib/shipstation-order-fallback-cron.ts) — only
    // ever populated when Shopify's own matching (orderGid above) has
    // nothing, never overwrites a real Shopify match. Not a Shopify GID, so
    // never wired into OrderPanel the way orderGid/orderName are.
    shipstationOrderFallback: text("shipstation_order_fallback"),
    shipstationShipToName: text("shipstation_ship_to_name"),
    shipstationOrderFallbackCheckedAt: text("shipstation_order_fallback_checked_at"),
    // On-time-delivery % (lib/shipstation-delivery-cron.ts) — see
    // lookupShipstationTracking's own comment in lib/shipstation.ts for why
    // this whole pair is flagged unverified. Delivered-on-time means
    // shipstationActualDeliveryAt <= shipstationEstimatedDeliveryAt.
    shipstationEstimatedDeliveryAt: text("shipstation_estimated_delivery_at"),
    shipstationActualDeliveryAt: text("shipstation_actual_delivery_at"),
    shipstationDeliveryCheckedAt: text("shipstation_delivery_checked_at"),
    // Rate-shop savings (lib/shipstation-rate-shop-cron.ts) — the cheapest
    // quote ShipStation's rate-estimate endpoint returned for this parcel's
    // real weight/dims/destination, to compare against what was actually
    // paid (shipstationCostAmount above). Same unverified-endpoint caveat as
    // the delivery-estimate columns — see lib/shipstation-rates.ts.
    shipstationBestRateAmount: real("shipstation_best_rate_amount"),
    shipstationBestRateCarrier: text("shipstation_best_rate_carrier"),
    shipstationBestRateCheckedAt: text("shipstation_best_rate_checked_at"),
  },
  (t) => [
    uniqueIndex("scan_tracking_number_idx").on(t.trackingNumber),
    // Two scans racing into the same session could otherwise both compute
    // the same max(sequence)+1 and both insert it — this index rejects the
    // loser at the DB layer instead of silently rendering two parcels under
    // the same number (see recordScan's retry-on-conflict in lib/shiplog.ts).
    uniqueIndex("scan_session_sequence_idx").on(t.sessionId, t.sequence),
  ],
);

/** A short-lived, server-side snapshot used to undo an accidental Reset Day. */
export const shipmentReset = pgTable("shipment_reset", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => shipmentSession.id),
  snapshot: text("snapshot").notNull(),
  resetAt: text("reset_at").notNull().default(nowUtcText),
  expiresAt: text("expires_at").notNull(),
  restoredAt: text("restored_at"),
  resetBy: text("reset_by").notNull().references(() => appUser.id),
});

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
  // 2-letter (Shopify's countryCodeV2) — see scan.destinationCountry's
  // comment; this is the local-index copy lookupOrderIndex hands back.
  destinationCountry: text("destination_country"),
  // See scan.customerShippingAmount's comment.
  customerShippingAmount: real("customer_shipping_amount"),
  customerShippingCurrency: text("customer_shipping_currency"),
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
  // Admin kill switch — leaves settings/history intact but blocks new
  // pickups from being previewed or booked (see lib/dhl-pickup.ts). An
  // already-active pickup can still be cancelled while this is off.
  enabled: boolean("enabled").notNull().default(true),
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
    // The actual calendar day booked with DHL (only set on a successful
    // "requested" row) — not derived by recomputing resolvePickupDate()
    // against the settings' current ready/close times, since an admin
    // editing those later would silently reinterpret an already-booked
    // pickup's date. Nullable: rows from before this column existed have no
    // value and just don't show a scheduled-date message.
    pickupDate: text("pickup_date"),
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

// Lets an admin dismiss a specific problem (exception/stale/shipping-loss —
// see lib/shipment-alerts.ts) off /admin/exceptions once they've looked at
// it. lib/shipment-alerts.ts's getProblemShipments has no other persisted
// state (a deliberate "always live" design, see its own comment) — this is
// the one exception, since "already handled" genuinely needs to survive
// across page loads and isn't derivable from the scan's own columns.
// Keyed by (scan, category) rather than just scan: a shipping loss is a
// fixed historical fact once cost/charged are known, so dismissing it stays
// dismissed forever, but an exception or stale scan can go on to develop a
// *different* problem later — dismissing today's doesn't pre-dismiss one
// that hasn't happened yet.
export const problemDismissal = pgTable(
  "problem_dismissal",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scan.id),
    category: text("category", { enum: ["exception", "stale", "loss"] }).notNull(),
    dismissedAt: text("dismissed_at").notNull().default(nowUtcText),
    dismissedBy: text("dismissed_by")
      .notNull()
      .references(() => appUser.id),
  },
  (t) => [uniqueIndex("problem_dismissal_scan_category_idx").on(t.scanId, t.category)],
);

// Single settings row controlling how a shipment detail page shows its EPG
// boxes — tabs (Box 01 / Box 02 / ...) or the original stacked list. Same
// fixed-id-singleton pattern as dhlPickupSettings; this isn't DHL-specific,
// just the one existing convention here for "one admin-editable setting, no
// per-user variation".
export const displaySettings = pgTable("display_settings", {
  id: text("id").primaryKey(),
  boxesAsTabs: boolean("boxes_as_tabs").notNull().default(true),
  // Shows/hides the per-parcel weight stamp next to the tracking number on
  // a shipment's scan table (see ScanTable.tsx) — an admin call, not a
  // per-user preference, same as boxesAsTabs above.
  showOrderWeight: boolean("show_order_weight").notNull().default(true),
  updatedAt: text("updated_at").notNull().default(nowUtcText),
  updatedBy: text("updated_by").references(() => appUser.id),
});

// One saved row per "Generate Insights" click on the Analytics page — so an
// admin can review a past AI-generated business insight later without
// re-spending tokens to regenerate it. Capped to the 10 most recent (see
// lib/ai-insights.ts's saveInsight), oldest trimmed off rather than growing
// unbounded.
export const aiInsight = pgTable("ai_insight", {
  id: text("id").primaryKey(),
  windowDays: integer("window_days").notNull(),
  text: text("text").notNull(),
  generatedAt: text("generated_at").notNull().default(nowUtcText),
  generatedBy: text("generated_by").references(() => appUser.id),
});

// Login rate-limit state, keyed by IP (see lib/auth.ts). Previously an
// in-memory Map, which only worked as a rate limit on a single long-lived
// process — this app runs on Vercel, where each concurrent serverless
// instance would have had its own independent counter, so the limit's
// effective throughput scaled with however many instances handled a burst
// of login attempts. A DB row is shared across every instance instead.
export const loginAttempt = pgTable("login_attempt", {
  ip: text("ip").primaryKey(),
  windowCount: integer("window_count").notNull(),
  windowStart: text("window_start").notNull(),
  cumulativeFailures: integer("cumulative_failures").notNull(),
  // Null means "not currently locked out", not "locked out at epoch zero".
  lockedUntil: text("locked_until"),
});

// Carrier invoice audits (lib/invoice-audit/) — one row per invoice,
// comparing what the carrier billed per parcel against what ShipStation
// quoted when the label was bought. Persisted rather than computed on the
// fly because audits also arrive unattended (the Gmail intake endpoint,
// app/api/v1/invoices/epg), and a disputed overcharge needs to be findable
// again later. Summary figures are denormalized onto this row so the audit
// list never has to aggregate every line.
export const invoiceAudit = pgTable(
  "invoice_audit",
  {
    id: text("id").primaryKey(),
    carrier: text("carrier", { enum: ["epg"] }).notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    fileName: text("file_name"),
    source: text("source", { enum: ["upload", "email"] }).notNull(),
    // Gmail message id for email-sourced audits — traceability back to the
    // exact email, not used for dedupe (invoiceNumber is the dedupe key).
    emailMessageId: text("email_message_id"),
    createdAt: text("created_at").notNull().default(nowUtcText),
    createdBy: text("created_by").references(() => appUser.id),
    currency: text("currency").notNull(),
    lineCount: integer("line_count").notNull(),
    invoicedTotal: real("invoiced_total").notNull(),
    // Sum over lines that have a quote only — compare against invoicedTotal
    // with care when noQuoteCount/notFoundCount are non-zero.
    quotedTotal: real("quoted_total").notNull(),
    overchargeTotal: real("overcharge_total").notNull(),
    underchargeTotal: real("undercharge_total").notNull(),
    overCount: integer("over_count").notNull(),
    underCount: integer("under_count").notNull(),
    matchCount: integer("match_count").notNull(),
    noQuoteCount: integer("no_quote_count").notNull(),
    notFoundCount: integer("not_found_count").notNull(),
    duplicateCount: integer("duplicate_count").notNull(),
  },
  // One audit per carrier invoice: the Gmail intake relies on this to make a
  // re-delivered email a no-op, and a manual re-upload replaces the row in
  // place (see lib/invoice-audit/audit.ts).
  (t) => [uniqueIndex("invoice_audit_carrier_invoice_idx").on(t.carrier, t.invoiceNumber)],
);

// One dispute sent (or being prepared) to a carrier about billing
// discrepancies. Its parcels are the invoice_audit_line rows pointing at it
// (disputeId below) — a parcel sits in at most one dispute, so a new dispute
// never re-sends one already disputed. Status is derived: draft until
// sentAt is set, then open until every line has an outcome.
export const invoiceDispute = pgTable("invoice_dispute", {
  id: text("id").primaryKey(),
  carrier: text("carrier", { enum: ["epg"] }).notNull(),
  createdAt: text("created_at").notNull().default(nowUtcText),
  createdBy: text("created_by").references(() => appUser.id),
  sentAt: text("sent_at"),
  sentBy: text("sent_by").references(() => appUser.id),
});

export const invoiceAuditLine = pgTable(
  "invoice_audit_line",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .notNull()
      .references(() => invoiceAudit.id, { onDelete: "cascade" }),
    sheetRow: integer("sheet_row").notNull(),
    awb: text("awb"),
    service: text("service"),
    // EPG label number (= scan.trackingNumber) and final-mile tracking
    // (= scan.epgFinalMile) — see lib/invoice-audit/epg-parse.ts.
    epgRef: text("epg_ref"),
    finalMileTracking: text("final_mile_tracking"),
    destinationCountry: text("destination_country"),
    actualWeightLb: real("actual_weight_lb"),
    dimWeightLb: real("dim_weight_lb"),
    billedWeightLb: real("billed_weight_lb"),
    sellRate: real("sell_rate").notNull(),
    surchargeTotal: real("surcharge_total").notNull(),
    invoicedAmount: real("invoiced_amount").notNull(),
    invoicedCurrency: text("invoiced_currency").notNull(),
    // Not a foreign key: scans get purged with trashed shipments, and an audit
    // is a historical record that shouldn't block (or vanish with) that purge.
    scanId: text("scan_id"),
    quoteSource: text("quote_source", { enum: ["scan", "shipstation"] }),
    quotedAmount: real("quoted_amount"),
    quotedCurrency: text("quoted_currency"),
    quotedWeightLb: real("quoted_weight_lb"),
    status: text("status", {
      enum: ["over", "under", "match", "no_quote", "not_found", "currency_mismatch", "duplicate"],
    }).notNull(),
    // invoiced − quoted; for a duplicate, the whole invoiced amount.
    difference: real("difference"),
    billedHeavier: boolean("billed_heavier").notNull().default(false),
    note: text("note"),
    // Dispute tracking (lib/invoice-audit/disputes.ts). All null until the
    // parcel is put in a dispute. disputedAmount is the overcharge as it
    // stood when disputed — what was actually claimed — so the dispute's
    // CSV doesn't shift if the audit is later re-run. A re-upload of the
    // invoice carries these over to the new lines (see auditEpgInvoice).
    disputeId: text("dispute_id").references(() => invoiceDispute.id, { onDelete: "set null" }),
    disputedAmount: real("disputed_amount"),
    disputeOutcome: text("dispute_outcome", { enum: ["pending", "credited", "rejected"] }),
    creditedAmount: real("credited_amount"),
    disputeResolvedAt: text("dispute_resolved_at"),
    // Set when an admin decides not to dispute this parcel (not worth
    // chasing, a charge known to be correct…). A skipped parcel is left out
    // of new disputes and of the "still to dispute" counts, and is never in
    // a dispute at the same time — see lib/invoice-audit/disputes.ts. A
    // re-upload of the invoice carries it over. Null = not skipped.
    disputeSkippedAt: text("dispute_skipped_at"),
    // Filled in from ShipStation and Shopify for parcels ship_logger has no
    // scan (or no scan order) for — lib/invoice-audit/enrich.ts. Ship date
    // is date-only ("YYYY-MM-DD"). orderRef is ShipStation's own
    // external_order_id for the parcel's shipment; the order* columns are
    // that order's shipping charge as Shopify reports it. enrichNote says
    // what went wrong when something couldn't be found; enrichedAt is when
    // the lookup last ran (null = never, so still a candidate).
    shipstationShipDate: text("shipstation_ship_date"),
    orderRef: text("order_ref"),
    orderName: text("order_name"),
    orderShippingAmount: real("order_shipping_amount"),
    orderShippingCurrency: text("order_shipping_currency"),
    enrichedAt: text("enriched_at"),
    enrichNote: text("enrich_note"),
  },
  (t) => [
    index("invoice_audit_line_audit_idx").on(t.auditId),
    // Cross-invoice duplicate check: has this EPG label been billed on an
    // earlier invoice already? (see lib/invoice-audit/audit.ts)
    index("invoice_audit_line_epg_ref_idx").on(t.epgRef),
    index("invoice_audit_line_dispute_idx").on(t.disputeId),
    index("invoice_audit_line_order_ref_idx").on(t.orderRef),
  ],
);
