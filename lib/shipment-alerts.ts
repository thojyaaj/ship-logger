import "server-only";
import { db } from "./db";
import { scan, shipmentSession, problemDismissal } from "./db/schema";
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { toSqlTimestamp, parseCarrierTimestamp, nowSqlTimestamp } from "./date";
import { carrierLabel, trackingUrl, EXCEPTION_STATUS_RE, type Carrier } from "./carrier";
import { sendAlertEmail } from "./email";
import { newId } from "./id";

export type ProblemCategory = "exception" | "stale" | "loss";

const LOOKBACK_DAYS = 90;
const STALE_DAYS = 7;

// Carriers with a real per-scan status feed. EPG scans can also carry
// exception-shaped text (customs holds are common on international mail),
// so it's included for the exceptions half; the stale check stays scoped to
// UPS/DHL per how this was asked for — EPG's status text is much less
// standardized, and epgtrack.com is already the least reliable of the three
// sources (see lib/epg.ts), so a 7-day-silent EPG scan is a weaker signal.
const EXCEPTION_CARRIERS: Carrier[] = ["ups", "dhl", "epg"];
const STALE_CARRIERS: Carrier[] = ["ups", "dhl"];

function isTerminal(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return /delivered|returned to sender|return to shipper/i.test(statusLabel);
}

function isException(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return EXCEPTION_STATUS_RE.test(statusLabel);
}

export type ProblemScan = {
  id: string;
  trackingNumber: string;
  carrier: Carrier;
  sessionId: string;
  orderName: string | null;
  statusLabel: string | null;
  statusAt: string | null;
  daysSinceUpdate: number;
  trackingUrl: string | null;
};

export type ShippingLossScan = {
  id: string;
  trackingNumber: string;
  carrier: Carrier;
  sessionId: string;
  orderName: string | null;
  costAmount: number;
  costCurrency: string | null;
  chargedAmount: number;
  chargedCurrency: string | null;
  lossAmount: number;
  trackingUrl: string | null;
};

export type ProblemShipments = {
  exceptions: ProblemScan[];
  stale: ProblemScan[];
  /** Cost paid (ShipStation) exceeded what the customer was charged for shipping (Shopify) — see the same-currency assumption noted in getProblemShipments. */
  losses: ShippingLossScan[];
};

function daysSince(value: string): number {
  const ms = Date.now() - parseCarrierTimestamp(value).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Live query — no stored "alert" table. Both the admin page and the daily
 * digest cron call this directly, so what's shown always matches what's
 * currently true rather than a snapshot from whenever the cron last ran.
 */
export async function getProblemShipments(): Promise<ProblemShipments> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const rows = await db
    .select({
      id: scan.id,
      trackingNumber: scan.trackingNumber,
      carrier: scan.carrier,
      sessionId: scan.sessionId,
      orderName: scan.orderName,
      statusLabel: scan.statusLabel,
      statusAt: scan.statusAt,
      scannedAt: scan.scannedAt,
      shipstationCostAmount: scan.shipstationCostAmount,
      shipstationCostCurrency: scan.shipstationCostCurrency,
      customerShippingAmount: scan.customerShippingAmount,
      customerShippingCurrency: scan.customerShippingCurrency,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(
        inArray(scan.carrier, EXCEPTION_CARRIERS),
        isNull(shipmentSession.deletedAt),
        ne(shipmentSession.status, "voided"),
        gt(scan.scannedAt, cutoff),
      ),
    );

  // Admin-dismissed (scan, category) pairs — see problemDismissal's comment
  // in lib/db/schema.ts for why this is keyed per-category rather than
  // per-scan. Fetched once for every scan in play rather than per-row.
  const scanIds = rows.map((r) => r.id);
  const dismissedRows =
    scanIds.length > 0
      ? await db
          .select({ scanId: problemDismissal.scanId, category: problemDismissal.category })
          .from(problemDismissal)
          .where(inArray(problemDismissal.scanId, scanIds))
      : [];
  const dismissed = new Set(dismissedRows.map((d) => `${d.scanId}:${d.category}`));
  const isDismissed = (scanId: string, category: ProblemCategory) => dismissed.has(`${scanId}:${category}`);

  const exceptions: ProblemScan[] = [];
  const stale: ProblemScan[] = [];
  const losses: ShippingLossScan[] = [];

  for (const r of rows) {
    // Same-currency assumption: this is a single-currency (USD) US
    // warehouse, so raw amounts are compared directly rather than converted.
    if (
      r.shipstationCostAmount !== null &&
      r.customerShippingAmount !== null &&
      r.shipstationCostAmount > r.customerShippingAmount &&
      !isDismissed(r.id, "loss")
    ) {
      losses.push({
        id: r.id,
        trackingNumber: r.trackingNumber,
        carrier: r.carrier as Carrier,
        sessionId: r.sessionId,
        orderName: r.orderName,
        costAmount: r.shipstationCostAmount,
        costCurrency: r.shipstationCostCurrency,
        chargedAmount: r.customerShippingAmount,
        chargedCurrency: r.customerShippingCurrency,
        lossAmount: Math.round((r.shipstationCostAmount - r.customerShippingAmount) * 100) / 100,
        trackingUrl: trackingUrl(r.carrier as Carrier, r.trackingNumber),
      });
    }

    // Last known movement: the carrier's own event time if we have one,
    // otherwise when it was scanned in — a scan that's never gotten a
    // status at all is exactly as stale as one whose status stopped moving.
    const lastUpdate = r.statusAt ?? r.scannedAt;
    const entry: ProblemScan = {
      id: r.id,
      trackingNumber: r.trackingNumber,
      carrier: r.carrier as Carrier,
      sessionId: r.sessionId,
      orderName: r.orderName,
      statusLabel: r.statusLabel,
      statusAt: r.statusAt,
      daysSinceUpdate: daysSince(lastUpdate),
      trackingUrl: trackingUrl(r.carrier as Carrier, r.trackingNumber),
    };

    if (isException(r.statusLabel)) {
      if (!isDismissed(r.id, "exception")) exceptions.push(entry);
      continue; // an exception scan isn't also double-counted as stale
    }

    if (
      STALE_CARRIERS.includes(r.carrier as Carrier) &&
      !isTerminal(r.statusLabel) &&
      entry.daysSinceUpdate >= STALE_DAYS &&
      !isDismissed(r.id, "stale")
    ) {
      stale.push(entry);
    }
  }

  exceptions.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
  stale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
  losses.sort((a, b) => b.lossAmount - a.lossAmount);

  return { exceptions, stale, losses };
}

export type ProblemSummary = { exceptionCount: number; staleCount: number; lossCount: number };

/** Cheap counts-only version for the in-app banner shown on every admin page load. */
export async function getProblemSummary(): Promise<ProblemSummary> {
  const { exceptions, stale, losses } = await getProblemShipments();
  return { exceptionCount: exceptions.length, staleCount: stale.length, lossCount: losses.length };
}

/**
 * Marks one (scan, category) problem as handled — excluded from
 * getProblemShipments, and therefore the banner/digest/exceptions page,
 * from then on. Idempotent: dismissing an already-dismissed pair is a
 * no-op rather than an error, so a double-click or a stale UI retry can't
 * fail.
 */
export async function dismissProblem(scanId: string, category: ProblemCategory, dismissedBy: string): Promise<void> {
  await db
    .insert(problemDismissal)
    .values({ id: newId(), scanId, category, dismissedBy, dismissedAt: nowSqlTimestamp() })
    .onConflictDoNothing({ target: [problemDismissal.scanId, problemDismissal.category] });
}

/** Bulk version for the "Dismiss selected" action on /admin/exceptions — one insert for the whole selection instead of one round-trip per row. */
export async function dismissProblems(
  items: { scanId: string; category: ProblemCategory }[],
  dismissedBy: string,
): Promise<void> {
  if (items.length === 0) return;
  const now = nowSqlTimestamp();
  await db
    .insert(problemDismissal)
    .values(items.map((item) => ({ id: newId(), scanId: item.scanId, category: item.category, dismissedBy, dismissedAt: now })))
    .onConflictDoNothing({ target: [problemDismissal.scanId, problemDismissal.category] });
}

function rowsHtml(items: ProblemScan[]): string {
  return items
    .map(
      (i) => `<tr>
        <td style="padding:4px 8px;font-family:monospace">${carrierLabel(i.carrier)}</td>
        <td style="padding:4px 8px;font-family:monospace">${i.trackingUrl ? `<a href="${i.trackingUrl}">${i.trackingNumber}</a>` : i.trackingNumber}</td>
        <td style="padding:4px 8px">${i.orderName ?? "—"}</td>
        <td style="padding:4px 8px">${i.statusLabel ?? "—"}</td>
        <td style="padding:4px 8px">${i.daysSinceUpdate}d</td>
        <td style="padding:4px 8px"><a href="https://ship.otcshoppeexpress.com/shipments/${i.sessionId}">shipment</a></td>
      </tr>`,
    )
    .join("");
}

function money(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

function lossRowsHtml(items: ShippingLossScan[]): string {
  return items
    .map(
      (i) => `<tr>
        <td style="padding:4px 8px;font-family:monospace">${carrierLabel(i.carrier)}</td>
        <td style="padding:4px 8px;font-family:monospace">${i.trackingUrl ? `<a href="${i.trackingUrl}">${i.trackingNumber}</a>` : i.trackingNumber}</td>
        <td style="padding:4px 8px">${i.orderName ?? "—"}</td>
        <td style="padding:4px 8px">${money(i.costAmount, i.costCurrency)}</td>
        <td style="padding:4px 8px">${money(i.chargedAmount, i.chargedCurrency)}</td>
        <td style="padding:4px 8px;color:#b00">-${money(i.lossAmount, i.costCurrency)}</td>
        <td style="padding:4px 8px"><a href="https://ship.otcshoppeexpress.com/shipments/${i.sessionId}">shipment</a></td>
      </tr>`,
    )
    .join("");
}

/**
 * Sends one digest email covering every currently-open problem — not one
 * email per newly-found problem. There's no stored "already notified" state
 * (see getProblemShipments), so this is deliberately a standing daily
 * reminder rather than a one-shot alert: an unresolved exception keeps
 * showing up in the digest every day until it's fixed, which is the
 * intended behavior for something an admin needs to actually act on.
 */
export async function runShipmentAlertsCron(): Promise<ProblemSummary> {
  const { exceptions, stale, losses } = await getProblemShipments();
  if (exceptions.length === 0 && stale.length === 0 && losses.length === 0) {
    return { exceptionCount: 0, staleCount: 0, lossCount: 0 };
  }

  const parts: string[] = [];
  if (exceptions.length > 0) {
    parts.push(
      `<h2>Exceptions (${exceptions.length})</h2><table>${rowsHtml(exceptions)}</table>`,
    );
  }
  if (stale.length > 0) {
    parts.push(
      `<h2>Stale — no update in ${STALE_DAYS}+ days (${stale.length})</h2><table>${rowsHtml(stale)}</table>`,
    );
  }
  if (losses.length > 0) {
    parts.push(
      `<h2>Shipping losses — paid more than charged (${losses.length})</h2><table>${lossRowsHtml(losses)}</table>`,
    );
  }

  await sendAlertEmail(
    `Ship Logger: ${exceptions.length} exception(s), ${stale.length} stale, ${losses.length} shipping loss(es)`,
    parts.join("<hr/>"),
  );

  return { exceptionCount: exceptions.length, staleCount: stale.length, lossCount: losses.length };
}
