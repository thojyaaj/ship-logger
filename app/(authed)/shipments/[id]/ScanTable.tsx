"use client";

import { useState } from "react";
import { trackingUrl } from "@/lib/carrier";
import { formatDbTimestamp } from "@/lib/date";
import OrderPanel from "../../OrderPanel";

type Row = {
  id: string;
  trackingNumber: string;
  carrier: string;
  scannedBy: string;
  scannedAt: string;
  orderGid: string | null;
  orderName: string | null;
  statusLabel: string | null;
};

/** §9c click-through, from history — same OrderPanel as the live scan screen. */
export default function ScanTable({
  rows,
  userNames,
}: {
  rows: Row[];
  userNames: Record<string, string>;
}) {
  const [openOrderGid, setOpenOrderGid] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[14%]" />
          <col className="w-[28%]" />
          <col className="w-[13%]" />
          <col className="w-[25%]" />
        </colgroup>
        <thead className="bg-paper-dim text-ink-faint">
          <tr>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Status</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Scanned By</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Scanned At</th>
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
                <td className="px-3 py-2 text-ink-faint data">{r.statusLabel ?? "—"}</td>
                <td className="px-3 py-2 font-condensed truncate">{userNames[r.scannedBy] ?? "?"}</td>
                <td className="px-3 py-2 text-ink-faint data truncate">{formatDbTimestamp(r.scannedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openOrderGid && <OrderPanel orderGid={openOrderGid} onClose={() => setOpenOrderGid(null)} />}
    </div>
  );
}
