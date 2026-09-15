"use client";

import { useState } from "react";
import ScanTable, { type Row } from "./ScanTable";

export type BoxData = {
  id: string;
  boxNumber: number;
  scanCount: number;
  upsTracking: string | null;
  weightLb: number | null;
  weighedCount: number;
  rows: Row[];
};

/** "4.2 lb" once every parcel in the box has a known weight, "4.2 lb, 1 unweighed" for a partial total, or null before any parcel does. */
function formatBoxWeight(box: BoxData): string | null {
  if (box.weightLb === null) return null;
  const unweighed = box.scanCount - box.weighedCount;
  return unweighed > 0 ? `${box.weightLb} lb, ${unweighed} unweighed` : `${box.weightLb} lb`;
}

function BoxHeading({ box }: { box: BoxData }) {
  const weight = formatBoxWeight(box);
  return (
    <h2 className="tag-label !text-sm !text-ink flex items-baseline gap-2">
      BOX {String(box.boxNumber).padStart(2, "0")}
      <span className="!normal-case !tracking-normal font-condensed text-ink-faint text-xs">
        ({box.scanCount} parcels{weight && `, ${weight}`})
      </span>
      {box.upsTracking && <span className="data text-ink-faint text-xs">{box.upsTracking}</span>}
    </h2>
  );
}

/**
 * EPG boxes as either tabs (one box visible at a time — the default, since a
 * shipment with many boxes turned this into one very long scroll) or the
 * original stacked list, per an admin-editable setting
 * (lib/display-settings.ts, toggled on /admin/users). Falls back to the
 * stacked layout regardless of the setting when there's only one box —
 * nothing to tab between.
 */
export default function BoxSections({ boxes, boxesAsTabs }: { boxes: BoxData[]; boxesAsTabs: boolean }) {
  const [activeBoxId, setActiveBoxId] = useState(boxes[0]?.id);

  if (boxes.length === 0) return null;

  if (!boxesAsTabs || boxes.length === 1) {
    return (
      <>
        {boxes.map((b) => (
          <div key={b.id} className="flex flex-col gap-1">
            <BoxHeading box={b} />
            <ScanTable rows={b.rows} />
          </div>
        ))}
      </>
    );
  }

  const active = boxes.find((b) => b.id === activeBoxId) ?? boxes[0];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 flex-wrap border-b border-line">
        {boxes.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setActiveBoxId(b.id)}
            className={`tag-label !text-xs px-3 py-2 border-b-2 -mb-px transition-colors ${
              b.id === active.id ? "border-ink !text-ink" : "border-transparent !text-ink-faint hover:!text-ink"
            }`}
          >
            Box {String(b.boxNumber).padStart(2, "0")}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <BoxHeading box={active} />
        <ScanTable rows={active.rows} />
      </div>
    </div>
  );
}
