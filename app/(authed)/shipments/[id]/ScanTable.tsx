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
                <td className="px-3 py-2 data truncate">
                  <span className="inline-flex items-center gap-1.5 max-w-full">
                    {/* Destination country — deliberately a solid-fill "stamp"
                        rather than the dim/pastel status badges elsewhere, so
                        it reads as its own thing rather than another status.
                        Shown on every viewport (unlike Status/Scanned At)
                        since it's the one piece of info here the user wants
                        visible at a glance, not just on desktop. */}
                    {r.destinationCountry && (
                      <span
                        className="shrink-0 inline-flex items-center justify-center px-1.5 py-0.5 text-[0.65rem] font-bold tracking-wide bg-ink text-paper"
                        title={`Destination: ${r.destinationCountry}`}
                      >
                        {r.destinationCountry}
                      </span>
                    )}
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="text-blue hover:underline truncate">
                        {r.trackingNumber}
                      </a>
                    ) : (
                      <span className="truncate">{r.trackingNumber}</span>
                    )}
                  </span>
                  {/* What we paid ShipStation for this label — moved here
                      (was under Order) so it sits with the tracking number
                      itself; the alert badge next to it is the whole point
                      of tracking this at all. */}
                  {cost && (
                    <span className="flex items-center gap-1.5 text-[0.65rem] text-ink-faint">
                      {cost}
                      {isLoss && (
                        <span
                          className="inline-flex items-center justify-center px-1 py-0.5 text-[0.6rem] font-bold bg-red text-paper"
                          title={`Paid ${cost} but only charged ${charged} for shipping — ${formatCost(
                            Math.round((r.shipstationCostAmount! - r.customerShippingAmount!) * 100) / 100,
                            r.shipstationCostCurrency,
                          )} lost on this parcel.`}
                        >
                          !
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 data truncate">
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
                      order — the figure the paid-cost line (above, under
                      Tracking) is meant to be compared against. */}
                  {charged && <span className="block text-[0.65rem] text-ink-faint">{charged}</span>}
                </td>
                <td className="hidden md:table-cell px-3 py-2 truncate" title={r.statusLabel ?? undefined}>
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
                <td className="hidden md:table-cell md:sticky md:right-0 md:z-[1] text-center px-3 py-2 text-ink-faint data truncate bg-paper-panel border-l border-line">
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
