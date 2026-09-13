"use client";

import { useState } from "react";
import { trackingUrl, statusTone } from "@/lib/carrier";
import { formatDbTimestamp } from "@/lib/date";
import OrderPanel from "../../OrderPanel";
import { ClockIcon } from "./icons";

type Row = {
  id: string;
  trackingNumber: string;
  carrier: string;
  scannedAt: string;
  orderGid: string | null;
  orderName: string | null;
  destinationCountry: string | null;
  shipstationCostAmount: number | null;
  shipstationCostCurrency: string | null;
  customerShippingAmount: number | null;
  customerShippingCurrency: string | null;
  shipstationOrderFallback: string | null;
  shipstationShipToName: string | null;
  statusLabel: string | null;
};

/** What the label actually cost, from ShipStation — null renders nothing (same "omit, don't blank" convention as the other ShipStation-sourced fields here). */
function formatCost(amount: number | null, currency: string | null): string | null {
  if (amount === null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

/**
 * One shared "stamp" look — solid-fill, bold, small-caps-tracked — for every
 * small inline indicator in this table (destination country, cost paid,
 * amount charged, the profit/loss confirmation). Same shape throughout,
 * only the background color changes, so the row reads as one consistent
 * badge system instead of a mix of plain text and one-off pill shapes.
 */
function Stamp({ bg, title, children }: { bg: string; title?: string; children: React.ReactNode }) {
  return (
    <span
      className={`shrink-0 inline-flex items-center justify-center px-1.5 py-0.5 text-[0.65rem] font-bold tracking-wide text-paper ${bg}`}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * §9c click-through, from history — same OrderPanel as the live scan screen.
 *
 * Deliberately NOT `table-fixed` — every row is meant to read as one line
 * (tracking + its badges, order + its badge), and a fixed percentage layout
 * fights that by forcing wraps/truncation to hit a column width chosen in
 * advance. Auto layout sizes each column to its content instead, and the
 * outer `overflow-x-auto` wrapper below picks up the slack on narrow
 * viewports — the same tradeoff this table already made for wide content
 * (see the Status column) is now just handled by the browser instead of a
 * hand-picked width.
 */
export default function ScanTable({ rows }: { rows: Row[] }) {
  const [openOrderGid, setOpenOrderGid] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm">
        <thead className="bg-paper-dim text-ink-faint">
          <tr>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
            <th className="hidden md:table-cell text-left px-3 py-2 tag-label !text-ink-faint">Status</th>
            <th className="hidden md:table-cell md:sticky md:right-0 md:z-[1] text-center px-3 py-2 tag-label !text-ink-faint bg-paper-dim border-l border-line">
              <span className="sr-only">Scanned At</span>
              <ClockIcon className="w-3.5 h-3.5 inline-block" />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const url = trackingUrl(r.carrier as "epg" | "ups" | "dhl", r.trackingNumber);
            const cost = formatCost(r.shipstationCostAmount, r.shipstationCostCurrency);
            const charged = formatCost(r.customerShippingAmount, r.customerShippingCurrency);
            // Same-currency assumption as lib/shipment-alerts.ts's loss
            // detection — this is a single-currency (USD) US warehouse.
            const isLoss =
              r.shipstationCostAmount !== null &&
              r.customerShippingAmount !== null &&
              r.shipstationCostAmount > r.customerShippingAmount;
            return (
              <tr key={r.id} className="border-t border-line bg-paper-panel">
                <td className="px-3 py-2 data align-top whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                        {r.trackingNumber}
                      </a>
                    ) : (
                      <span>{r.trackingNumber}</span>
                    )}
                    {r.destinationCountry && <Stamp bg="bg-ink" title={`Destination: ${r.destinationCountry}`}>{r.destinationCountry}</Stamp>}
                    {cost && (
                      <Stamp bg="bg-blue" title={`Paid to ShipStation: ${cost}`}>
                        {cost}
                      </Stamp>
                    )}
                    {/* Confirmation stamp — only rendered once both cost paid
                        and amount charged are known, so it's never a false
                        "profitable" read against incomplete data. Green
                        confirms this parcel didn't lose money; red is the
                        same loss condition surfaced in
                        lib/shipment-alerts.ts's exceptions system. */}
                    {r.shipstationCostAmount !== null && r.customerShippingAmount !== null && (
                      <Stamp
                        bg={isLoss ? "bg-red" : "bg-green"}
                        title={
                          isLoss
                            ? `Losing money: paid ${cost}, charged ${charged}.`
                            : `Paid ${cost}, charged ${charged} — no loss on this parcel.`
                        }
                      >
                        {isLoss ? "!" : "OK"}
                      </Stamp>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 data align-top whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {r.orderGid ? (
                      <button type="button" onClick={() => setOpenOrderGid(r.orderGid)} className="text-blue hover:underline">
                        {r.orderName}
                      </button>
                    ) : r.shipstationOrderFallback || r.shipstationShipToName ? (
                      // Fallback only — Shopify's own matching (lib/order-index.ts,
                      // lib/epg-cron.ts) found nothing for this scan. Not a
                      // Shopify GID, so plain text rather than an OrderPanel
                      // button, and labeled so it's never mistaken for a real match.
                      <span className="text-ink-faint" title="No Shopify match — from ShipStation's label data">
                        {r.shipstationOrderFallback ?? r.shipstationShipToName}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                    {/* What the customer was charged for shipping on this
                        order — the figure the paid-cost stamp (Tracking
                        column) is meant to be compared against. */}
                    {charged && (
                      <Stamp bg="bg-amber" title={`Charged to customer: ${charged}`}>
                        {charged}
                      </Stamp>
                    )}
                  </span>
                </td>
                <td className="hidden md:table-cell px-3 py-2 align-top" title={r.statusLabel ?? undefined}>
                  {r.statusLabel ? (
                    <span
                      className={`tag-label !text-[0.65rem] px-1.5 py-0.5 inline-block max-w-[220px] truncate align-bottom ${statusTone(r.statusLabel)}`}
                    >
                      {r.statusLabel}
                    </span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="hidden md:table-cell md:sticky md:right-0 md:z-[1] text-center px-3 py-2 text-ink-faint bg-paper-panel border-l border-line align-top">
                  {/* Icon instead of the full timestamp to save row width —
                      hover/focus for the actual date and time via the
                      native title tooltip. */}
                  <span title={formatDbTimestamp(r.scannedAt)} className="inline-flex">
                    <ClockIcon className="w-4 h-4" />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openOrderGid && <OrderPanel orderGid={openOrderGid} onClose={() => setOpenOrderGid(null)} />}
    </div>
  );
}
