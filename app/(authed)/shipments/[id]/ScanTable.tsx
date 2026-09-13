"use client";

import { useState } from "react";
import { trackingUrl, statusTone } from "@/lib/carrier";
import { formatDbTimestamp } from "@/lib/date";
import OrderPanel from "../../OrderPanel";

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

/** §9c click-through, from history — same OrderPanel as the live scan screen. */
export default function ScanTable({ rows }: { rows: Row[] }) {
  const [openOrderGid, setOpenOrderGid] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-[60%] md:w-[28%]" />
          <col className="w-[40%] md:w-[14%]" />
          {/* Narrowed from 41% so a full un-truncated UPS "1Z..." tracking
              number (widened to 28% above) actually fits on desktop —
              status labels are still legible at this width, they just wrap
              or truncate a little sooner on the longest ones. */}
          <col className="hidden md:table-column md:w-[33%]" />
          <col className="hidden md:table-column md:w-[25%]" />
        </colgroup>
        <thead className="bg-paper-dim text-ink-faint">
          <tr>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
            {/* Status/At are useful on desktop for auditing but
                just crowd the tracking/order columns on a phone-width
                screen — dropped there rather than shrunk further. Scanned
                At is pinned to the right edge (md:sticky) rather than
                sharing the table-fixed split evenly — a timestamp doesn't
                need much room, and pinning it frees the space for Status,
                whose carrier-status labels ("DEPARTED FROM FACILITY") are
                the ones that actually need it. */}
            <th className="hidden md:table-cell text-left px-3 py-2 tag-label !text-ink-faint">Status</th>
            <th className="hidden md:table-cell md:sticky md:right-0 md:z-[1] text-center px-3 py-2 tag-label !text-ink-faint bg-paper-dim border-l border-line">
              Scanned At
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
                <td className="px-3 py-2 data align-top">
                  {/* Tracking number gets its own line, full width — no
                      badge crowding it, which is what made the previous
                      layout hard to read. Country/cost/profit-check are a
                      second, smaller line underneath instead of squeezed
                      onto the same line or split across two cells. */}
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" className="block text-blue hover:underline truncate">
                      {r.trackingNumber}
                    </a>
                  ) : (
                    <span className="block truncate">{r.trackingNumber}</span>
                  )}
                  {(r.destinationCountry || cost) && (
                    <span className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {r.destinationCountry && <Stamp bg="bg-ink" title={`Destination: ${r.destinationCountry}`}>{r.destinationCountry}</Stamp>}
                      {cost && (
                        <Stamp bg="bg-blue" title={`Paid to ShipStation: ${cost}`}>
                          {cost}
                        </Stamp>
                      )}
                      {/* Confirmation stamp — only rendered once both cost
                          paid and amount charged are known, so it's never a
                          false "profitable" read against incomplete data.
                          Green confirms this parcel didn't lose money; red
                          is the same loss condition surfaced in
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
                  )}
                </td>
                <td className="px-3 py-2 data truncate align-top">
                  {r.orderGid ? (
                    <button
                      type="button"
                      onClick={() => setOpenOrderGid(r.orderGid)}
                      className="text-blue hover:underline"
                    >
                      {r.orderName}
                    </button>
                  ) : r.shipstationOrderFallback || r.shipstationShipToName ? (
                    // Fallback only — Shopify's own matching (lib/order-index.ts,
                    // lib/epg-cron.ts) found nothing for this scan. Not a
                    // Shopify GID, so plain text rather than an OrderPanel
                    // button, and labeled so it's never mistaken for a real match.
                    <span className="text-ink-faint truncate" title="No Shopify match — from ShipStation's label data">
                      {r.shipstationOrderFallback ?? r.shipstationShipToName}
                    </span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                  {/* What the customer was charged for shipping on this
                      order — the figure the paid-cost stamp (above, under
                      Tracking) is meant to be compared against. */}
                  {charged && (
                    <span className="block mt-1">
                      <Stamp bg="bg-amber" title={`Charged to customer: ${charged}`}>
                        {charged}
                      </Stamp>
                    </span>
                  )}
                </td>
                <td className="hidden md:table-cell px-3 py-2 truncate align-top" title={r.statusLabel ?? undefined}>
                  {r.statusLabel ? (
                    <span
                      className={`tag-label !text-[0.65rem] px-1.5 py-0.5 inline-block max-w-full truncate ${statusTone(r.statusLabel)}`}
                    >
                      {r.statusLabel}
                    </span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="hidden md:table-cell md:sticky md:right-0 md:z-[1] text-center px-3 py-2 text-ink-faint data truncate bg-paper-panel border-l border-line align-top">
                  {formatDbTimestamp(r.scannedAt)}
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
