"use client";

import { useState } from "react";
import { trackingUrl } from "@/lib/carrier";
import { formatDbTimestamp } from "@/lib/date";
import OrderPanel from "../../OrderPanel";

type Row = {
  id: string;
  trackingNumber: string;
  carrier: string;
  scannedAt: string;
  orderGid: string | null;
  orderName: string | null;
  statusLabel: string | null;
};

/** §9c click-through, from history — same OrderPanel as the live scan screen. */
export default function ScanTable({ rows }: { rows: Row[] }) {
  const [openOrderGid, setOpenOrderGid] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-[60%] md:w-[20%]" />
          <col className="w-[40%] md:w-[14%]" />
          <col className="hidden md:table-column md:w-[41%]" />
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
            <th className="hidden md:table-cell md:sticky md:right-0 md:z-10 text-left px-3 py-2 tag-label !text-ink-faint bg-paper-dim border-l border-line">
              Scanned At
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const url = trackingUrl(r.carrier as "epg" | "ups" | "dhl", r.trackingNumber);
            return (
              <tr key={r.id} className="border-t border-line bg-paper-panel">
                <td className="px-3 py-2 data truncate">
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                      {r.trackingNumber}
                    </a>
                  ) : (
                    r.trackingNumber
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
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="hidden md:table-cell px-3 py-2 text-ink-faint data">{r.statusLabel ?? "—"}</td>
                <td className="hidden md:table-cell md:sticky md:right-0 md:z-10 px-3 py-2 text-ink-faint data truncate bg-paper-panel border-l border-line">
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
