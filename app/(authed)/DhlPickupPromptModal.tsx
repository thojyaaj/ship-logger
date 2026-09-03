"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import type { PreviewPickup } from "@/lib/dhl-pickup";
import { previewPickupAction, schedulePickupAction } from "./shipments/[id]/dhl-pickup-actions";
import ConfirmDialog from "./ConfirmDialog";
import Toast from "./Toast";
import { useDismissable } from "./useDismissable";
import { actionErrorMessage } from "@/lib/error-message";

/**
 * Shown once, right after a packer submits a shipment that has DHL parcels —
 * scheduling pickup is the very next thing they'd otherwise have to remember
 * to ask an admin for. Still entirely opt-in ("Not now" just closes it), and
 * scheduling itself goes through the same preview-then-confirm flow as the
 * admin panel on the shipment detail page before anything is sent to DHL.
 */
export default function DhlPickupPromptModal({
  sessionId,
  dhlCount,
  onDone,
}: {
  sessionId: string;
  dhlCount: number;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<PreviewPickup | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [isPending, startTransition] = useTransition();
  useDismissable(onDone);

  function openScheduleDialog() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await previewPickupAction(sessionId);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setPreview(result.preview);
        setShowConfirm(true);
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't compute the pickup preview."));
      }
    });
  }

  function confirmSchedule() {
    setShowConfirm(false);
    startTransition(async () => {
      try {
        const result = await schedulePickupAction(sessionId);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setScheduled(true);
      } catch (err) {
        setError(actionErrorMessage(err, "Pickup scheduling failed — please retry."));
      }
    });
  }

  if (scheduled) {
    return <Toast message="DHL pickup scheduled" onDismiss={onDone} />;
  }

  return createPortal(
    <div className="fixed inset-0 bg-ink/60 flex items-center justify-center p-4 z-20" onClick={onDone}>
      <div
        className="corners bg-paper-panel p-6 max-w-sm w-full flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between route-line pb-3">
          <h2 className="font-stencil text-xl tracking-wide">Schedule DHL Pickup?</h2>
          <span className="barcode w-16 h-4" />
        </div>

        <p className="text-sm text-ink-soft">
          This shipment has{" "}
          <span className="font-semibold text-amber-ink">
            {dhlCount} DHL parcel{dhlCount === 1 ? "" : "s"}
          </span>
          . Schedule a pickup now?
        </p>

        {error && (
          <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink font-medium text-sm">
            {error}
          </p>
        )}

        <div className="flex gap-3 mt-2">
          <button
            type="button"
            onClick={onDone}
            className="btn flex-1 py-3 border border-line-strong text-ink hover:bg-paper-dim"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={openScheduleDialog}
            disabled={isPending}
            className="btn flex-1 py-3 bg-orange text-paper disabled:opacity-50"
          >
            {isPending ? "Checking…" : "Schedule Pickup"}
          </button>
        </div>
      </div>

      {showConfirm && preview && (
        <ConfirmDialog
          title="Schedule this DHL pickup?"
          message={
            <>
              This books a real pickup with DHL — a truck will be dispatched.
              <span className="block text-base font-semibold text-ink mt-3">{preview.pickupDateLabel}</span>
              <span className="block text-base font-semibold text-ink">
                {preview.readyTimeLabel} – {preview.closeTimeLabel}
              </span>
              <span className="block text-ink-faint mt-2">
                {preview.parcelCount} parcel(s), ~{preview.totalWeightLb} lb
              </span>
            </>
          }
          confirmLabel="Schedule pickup"
          onCancel={() => setShowConfirm(false)}
          onConfirm={confirmSchedule}
        />
      )}
    </div>,
    document.body,
  );
}
