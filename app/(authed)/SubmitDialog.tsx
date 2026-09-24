"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { SessionDashboard } from "@/lib/shiplog";
import { localCalendarDate } from "@/lib/date";
import { submitSessionAction, createMasterLabelDraftAction, syncMasterUpsTrackingAction } from "./scan-actions";
import { useDismissable } from "./useDismissable";
import { actionErrorMessage } from "@/lib/error-message";
import { withTransportRetry } from "@/lib/with-retry";

// How often to re-check ShipStation for the purchased label once a draft
// exists — see the "Master label" section below. Frequent enough that a
// packer isn't left staring at a stale screen after buying the label, but
// not so tight it hammers ShipStation while they're still over at the scale.
const SYNC_POLL_MS = 5000;

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
  // Defaults to today (the day this shipment is actually being submitted),
  // not `dashboard.session.shipDate` — that's the day the session was
  // opened, which can be an earlier calendar day than the day it ships.
  const [shipDate, setShipDate] = useState(localCalendarDate());
  const [notes, setNotes] = useState(dashboard.session.notes ?? "");
  const [showBoxTracking, setShowBoxTracking] = useState(false);
  const [boxUpsTracking, setBoxUpsTracking] = useState<Record<string, string>>(
    Object.fromEntries(dashboard.boxes.map((b) => [b.id, b.upsTracking ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Step 1 of closing out an EPG shipment: the AWB can only be generated
  // once a master UPS tracking number exists, and that number only exists
  // once a real label has been bought in ShipStation — so masterUpsTracking
  // can't just be a text field here the way it used to be. See
  // lib/shipstation-epg-label.ts for the draft-then-sync flow this drives.
  const [shipmentId, setShipmentId] = useState(dashboard.session.shipstationShipmentId);
  const [draftStatus, setDraftStatus] = useState(dashboard.session.shipstationDraftStatus);
  const [draftError, setDraftError] = useState(dashboard.session.shipstationDraftError);
  const [syncing, setSyncing] = useState(false);
  // Escape hatch: skip waiting on ShipStation entirely and type the AWB/
  // master tracking in by hand, same as before this automation existed —
  // always available, never just a fallback for when the draft errors.
  const [manualEntry, setManualEntry] = useState(false);
  const needsMasterTracking = hasEpg && !manualEntry && !masterUpsTracking.trim();

  // Was the only modal with no Escape and no backdrop close — Cancel was the
  // sole way out.
  useDismissable(onClose);

  // Kicks off the ShipStation draft the moment this step is reached, if it
  // doesn't already have one. draftSessionShipment is idempotent, so this
  // is safe to fire on every mount — the ref just stops this effect from
  // firing the request twice under React's dev-mode double-invoke.
  const draftingRef = useRef(false);
  useEffect(() => {
    if (!needsMasterTracking || shipmentId || draftingRef.current) return;
    draftingRef.current = true;
    createMasterLabelDraftAction(dashboard.session.id)
      .then((result) => {
        setShipmentId(result.shipstationShipmentId);
        setDraftStatus(result.shipstationDraftStatus);
        setDraftError(result.shipstationDraftError);
      })
      .catch((err) => setDraftError(actionErrorMessage(err, "Couldn't reach ShipStation — try again.")))
      .finally(() => {
        draftingRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsMasterTracking, shipmentId]);

  // Polls for the purchased label once a draft exists, until either the
  // tracking number lands or this dialog closes/switches to manual entry.
  const pollingRef = useRef(false);
  useEffect(() => {
    if (!needsMasterTracking || !shipmentId || draftStatus !== "created") return;

    let cancelled = false;
    async function poll() {
      if (pollingRef.current) return; // don't overlap a slow request with the next tick
      pollingRef.current = true;
      setSyncing(true);
      try {
        const result = await syncMasterUpsTrackingAction(dashboard.session.id);
        if (cancelled) return;
        if (result.status === "ok") setMasterUpsTracking(result.masterUpsTracking);
        else if (result.status === "error") setDraftError(result.message);
      } catch {
        // Transient — the next tick just retries.
      } finally {
        pollingRef.current = false;
        if (!cancelled) setSyncing(false);
      }
    }

    poll(); // check immediately on mount rather than waiting a full interval
    const id = setInterval(poll, SYNC_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsMasterTracking, shipmentId, draftStatus]);

  function applyToAllBoxes() {
    const first = dashboard.boxes[0];
    if (!first) return;
    const value = boxUpsTracking[first.id] ?? "";
    setBoxUpsTracking(Object.fromEntries(dashboard.boxes.map((b) => [b.id, value])));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        // The only mutation that wasn't retried, and the only one with no
        // catch: a dropped connection reset the button to "Submit" with no
        // message at all, so a packer couldn't tell whether the day had been
        // submitted or not.
        const result = await withTransportRetry(() =>
          submitSessionAction({
            sessionId: dashboard.session.id,
            awbNumber,
            masterUpsTracking,
            shipDate,
            notes,
            boxUpsTracking,
          }),
        );
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        onSubmitted();
      } catch (err) {
        setError(actionErrorMessage(err, "Submit failed — check the connection and try again."));
      }
    });
  }

  return (
    <div className="fixed inset-0 bg-ink/60 flex items-center justify-center p-4 z-20" onClick={onClose}>
      <div
        className="corners bg-paper-panel p-6 max-w-lg w-full flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between route-line pb-3">
          <h2 className="font-stencil text-xl tracking-wide">Submit Shipment</h2>
          <span className="barcode w-16 h-4" />
        </div>

        <div className="data text-sm text-ink-soft flex gap-3 flex-wrap">
          <span className="text-epg font-semibold">{dashboard.totals.epg} EPG</span>
          <span className="text-ups font-semibold">{dashboard.totals.ups} UPS</span>
          <span className="text-dhl-ink font-semibold">{dashboard.totals.dhl} DHL</span>
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

        {hasEpg && needsMasterTracking && (
          <div className="flex flex-col gap-2 border-l-4 border-orange bg-paper-dim p-3">
            <span className="tag-label">Master UPS label</span>
            {draftStatus === "error" ? (
              <>
                <p className="text-sm text-red-ink">{draftError ?? "Couldn't draft the ShipStation shipment."}</p>
                <button
                  type="button"
                  onClick={() => {
                    setDraftError(null);
                    setDraftStatus(null);
                  }}
                  className="tag-label !text-blue self-start"
                >
                  Retry
                </button>
              </>
            ) : shipmentId ? (
              <>
                <p className="text-sm text-ink-soft font-condensed">
                  Drafted in ShipStation (shipment {shipmentId}) — open it there, weigh each box, and buy the
                  label. This will pick up the tracking number automatically once it&apos;s bought
                  {syncing ? "…" : "."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSyncing(true);
                    syncMasterUpsTrackingAction(dashboard.session.id)
                      .then((result) => {
                        if (result.status === "ok") setMasterUpsTracking(result.masterUpsTracking);
                        else if (result.status === "error") setDraftError(result.message);
                      })
                      .finally(() => setSyncing(false));
                  }}
                  disabled={syncing}
                  className="tag-label !text-blue self-start disabled:opacity-50"
                >
                  {syncing ? "Checking…" : "Check now"}
                </button>
              </>
            ) : (
              <p className="text-sm text-ink-soft font-condensed">Drafting the ShipStation shipment…</p>
            )}
            <button
              type="button"
              onClick={() => setManualEntry(true)}
              className="tag-label !text-ink-faint self-start"
            >
              Enter AWB / tracking manually instead
            </button>
          </div>
        )}

        {hasEpg && !needsMasterTracking && (
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
                          className="data flex-1 min-w-0 border border-line px-2 py-1 text-sm bg-paper"
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
