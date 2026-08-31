"use client";

import { useState, useTransition } from "react";
import type { SessionDashboard } from "@/lib/shiplog";
import { submitSessionAction } from "./scan-actions";

export default function SubmitDialog({
  dashboard,
  onClose,
  onSubmitted,
}: {
  dashboard: SessionDashboard;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const hasEpg = dashboard.totals.epg > 0;
  const [awbNumber, setAwbNumber] = useState(dashboard.session.awbNumber ?? "");
  const [masterUpsTracking, setMasterUpsTracking] = useState(dashboard.session.masterUpsTracking ?? "");
  const [shipDate, setShipDate] = useState(dashboard.session.shipDate);
  const [notes, setNotes] = useState(dashboard.session.notes ?? "");
  const [showBoxTracking, setShowBoxTracking] = useState(false);
  const [boxUpsTracking, setBoxUpsTracking] = useState<Record<string, string>>(
    Object.fromEntries(dashboard.boxes.map((b) => [b.id, b.upsTracking ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function applyToAllBoxes() {
    const first = dashboard.boxes[0];
    if (!first) return;
    const value = boxUpsTracking[first.id] ?? "";
    setBoxUpsTracking(Object.fromEntries(dashboard.boxes.map((b) => [b.id, value])));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await submitSessionAction({
        sessionId: dashboard.session.id,
        awbNumber,
        masterUpsTracking,
        shipDate,
        notes,
        boxUpsTracking,
      });
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      onSubmitted();
    });
  }

  return (
    <div className="fixed inset-0 bg-ink/60 flex items-center justify-center p-4 z-20">
      <div className="corners bg-paper-panel p-6 max-w-lg w-full flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between route-line pb-3">
          <h2 className="font-stencil text-xl tracking-wide">Submit Shipment</h2>
          <span className="barcode w-16 h-4" />
        </div>

        <div className="data text-sm text-ink-soft flex gap-3 flex-wrap">
          <span className="text-orange font-semibold">{dashboard.totals.epg} EPG</span>
          <span className="text-blue font-semibold">{dashboard.totals.ups} UPS</span>
          <span className="text-amber font-semibold">{dashboard.totals.dhl} DHL</span>
          <span>
            · {dashboard.boxes.length} box{dashboard.boxes.length === 1 ? "" : "es"}
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="tag-label">Ship date</span>
          <input
            type="date"
            value={shipDate}
            onChange={(e) => setShipDate(e.target.value)}
            className="data border border-line-strong px-3 py-2 bg-paper"
          />
        </label>

        {hasEpg && (
          <>
            <label className="flex flex-col gap-1">
              <span className="tag-label">
                AWB <span className="text-red">*</span>{" "}
                <span className="!normal-case !tracking-normal font-condensed text-ink-faint">
                  — one per consolidated shipment
                </span>
              </span>
              <input
                value={awbNumber}
                onChange={(e) => setAwbNumber(e.target.value)}
                className="data border border-line-strong px-3 py-2 bg-paper"
                placeholder="AWB number"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="tag-label">
                Master UPS tracking <span className="text-red">*</span>{" "}
                <span className="!normal-case !tracking-normal font-condensed text-ink-faint">
                  — multi-piece shipment, covers every box
                </span>
              </span>
              <input
                value={masterUpsTracking}
                onChange={(e) => setMasterUpsTracking(e.target.value)}
                className="data border border-line-strong px-3 py-2 bg-paper"
                placeholder="1Z..."
              />
            </label>

            {dashboard.boxes.length > 0 && (
              <div className="border border-line">
                <button
                  type="button"
                  onClick={() => setShowBoxTracking((v) => !v)}
                  className="tag-label w-full text-left px-3 py-2"
                >
                  {showBoxTracking ? "▾" : "▸"} Per-box tracking numbers (optional)
                </button>
                {showBoxTracking && (
                  <div className="flex flex-col gap-2 p-3 pt-0">
                    {dashboard.boxes.map((b) => (
                      <label key={b.id} className="flex items-center gap-2 text-sm">
                        <span className="data w-20 shrink-0 text-ink-soft">
                          BOX {String(b.boxNumber).padStart(2, "0")}
                        </span>
                        <input
                          value={boxUpsTracking[b.id] ?? ""}
                          onChange={(e) =>
                            setBoxUpsTracking((prev) => ({ ...prev, [b.id]: e.target.value }))
                          }
                          className="data flex-1 border border-line px-2 py-1 text-sm bg-paper"
                          placeholder="optional piece tracking"
                        />
                      </label>
                    ))}
                    {dashboard.boxes.length > 1 && (
                      <button
                        type="button"
                        onClick={applyToAllBoxes}
                        className="tag-label !text-blue self-start"
                      >
                        Copy Box 1&apos;s number to all boxes
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <label className="flex flex-col gap-1">
          <span className="tag-label">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="border border-line-strong px-3 py-2 bg-paper font-condensed"
            rows={2}
          />
        </label>

        {error && (
          <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink font-medium text-sm">
            ⚠ {error}
          </p>
        )}

        <div className="flex gap-3 mt-2">
          <button
            type="button"
            onClick={onClose}
            className="btn flex-1 py-3 border border-line-strong text-ink hover:bg-paper-dim"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="btn flex-1 py-3 bg-orange text-paper disabled:opacity-50"
          >
            {isPending ? "Submitting…" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
