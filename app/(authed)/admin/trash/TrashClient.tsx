"use client";

import { useState, useTransition } from "react";
import type { TrashedShipmentItem } from "@/lib/shiplog";
import { restoreShipmentAction } from "../../scan-actions";
import { formatDbTimestamp } from "@/lib/date";
import { actionErrorMessage } from "@/lib/error-message";

// Matches lib/shiplog.ts's TRASH_RETENTION_DAYS — just the copy here, the
// actual per-row countdown comes from the server as daysUntilPurge (see
// listTrashedShipments) since React's purity rules don't allow reading
// "now" during render.
const RETENTION_DAYS = 30;

export default function TrashClient({ initialShipments }: { initialShipments: TrashedShipmentItem[] }) {
  const [shipments, setShipments] = useState(initialShipments);

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-baseline justify-between route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Trash</h1>
        <span className="tag-label">{shipments.length} in trash</span>
      </div>
      <p className="text-sm text-ink-faint font-condensed">
        Deleted shipments stay here for {RETENTION_DAYS} days before being permanently purged. Restore one to put
        it back in the shipments log.
      </p>
      <div className="flex flex-col border-t border-line">
        {shipments.map((s) => (
          <TrashRow
            key={s.id}
            shipment={s}
            onRestored={() => setShipments((cur) => cur.filter((x) => x.id !== s.id))}
          />
        ))}
        {shipments.length === 0 && (
          <p className="text-ink-faint text-center py-12 border-b border-line data">TRASH IS EMPTY</p>
        )}
      </div>
    </div>
  );
}

function TrashRow({ shipment: s, onRestored }: { shipment: TrashedShipmentItem; onRestored: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const daysLeft = s.daysUntilPurge;

  function restore() {
    setError(null);
    startTransition(async () => {
      try {
        await restoreShipmentAction(s.id);
        onRestored();
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't restore this shipment."));
      }
    });
  }

  return (
    <div className="flex flex-col border-b border-line">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3 bg-paper-panel">
        <div className="sm:w-32 sm:shrink-0">
          <div className="data font-semibold">{s.shipDate}</div>
          <div className="tag-label !text-[0.6rem] !text-ink-faint">deleted {formatDbTimestamp(s.deletedAt)}</div>
        </div>
        <div className="flex-1 flex flex-wrap gap-x-4 gap-y-1 text-sm data">
          <span className="text-orange">EPG {s.totals.epg}</span>
          <span className="text-blue">UPS {s.totals.ups}</span>
          <span className="text-amber">DHL {s.totals.dhl}</span>
          {s.boxCount > 0 && <span className="text-ink-soft">{s.boxCount} box(es)</span>}
        </div>
        <span className={`tag-label !text-[0.6rem] shrink-0 ${daysLeft <= 3 ? "!text-red" : "!text-ink-faint"}`}>
          {daysLeft === 0 ? "purging soon" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
        </span>
        <button
          type="button"
          onClick={restore}
          disabled={isPending}
          className="btn px-4 py-2 border border-line-strong text-ink hover:bg-paper-dim disabled:opacity-50 shrink-0"
        >
          {isPending ? "Restoring…" : "Restore"}
        </button>
      </div>
      {error && <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
    </div>
  );
}
