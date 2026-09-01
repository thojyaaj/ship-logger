"use client";

import { useState, useTransition } from "react";
import type { PickupRequestRecord, PreviewPickup } from "@/lib/dhl-pickup";
import { previewPickupAction, schedulePickupAction, cancelPickupAction } from "./dhl-pickup-actions";
import ConfirmDialog from "../../ConfirmDialog";
import { formatDbTimestamp } from "@/lib/date";
import { actionErrorMessage } from "@/lib/error-message";

/**
 * Only rendered when the parent page has already confirmed this shipment is
 * submitted and has DHL parcels — see shipments/[id]/page.tsx. Booking a
 * pickup is never automatic: every path here requires an explicit admin
 * click on a dialog that shows the computed weight/count/window before
 * anything is actually sent to DHL.
 */
export default function DhlPickupPanel({
  sessionId,
  initialRequest,
}: {
  sessionId: string;
  initialRequest: PickupRequestRecord | null;
}) {
  const [request, setRequest] = useState(initialRequest);
  const [preview, setPreview] = useState<PreviewPickup | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const active = request?.status === "requested";

  function openScheduleDialog() {
    setError(null);
    setPreviewError(null);
    startTransition(async () => {
      try {
        const result = await previewPickupAction(sessionId);
        if (result.status === "error") {
          setPreviewError(result.message);
          return;
        }
        setPreview(result.preview);
        setShowConfirm(true);
      } catch (err) {
        setPreviewError(actionErrorMessage(err, "Couldn't compute the pickup preview."));
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
        setRequest({
          id: "", // not needed for display; refresh would replace it with the real row
          status: "requested",
          dispatchConfirmationNumber: result.dispatchConfirmationNumber,
          parcelCount: result.parcelCount,
          totalWeightLb: result.totalWeightLb,
          requestedAt: new Date().toISOString(),
          errorMessage: null,
          cancelledAt: null,
        });
      } catch (err) {
        setError(actionErrorMessage(err, "Pickup scheduling failed — please retry."));
      }
    });
  }

  function confirmCancel() {
    setShowCancelConfirm(false);
    startTransition(async () => {
      try {
        const result = await cancelPickupAction(sessionId);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setRequest((r) => (r ? { ...r, status: "cancelled", cancelledAt: new Date().toISOString() } : r));
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't cancel the pickup — please retry."));
      }
    });
  }

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <h2 className="tag-label">DHL Pickup</h2>

      {active && request?.dispatchConfirmationNumber && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-condensed">
            Scheduled — confirmation <span className="data font-semibold">{request.dispatchConfirmationNumber}</span>
            <br />
            <span className="text-ink-faint text-xs">
              {request.parcelCount} parcel(s), ~{request.totalWeightLb} lb, requested{" "}
              {formatDbTimestamp(request.requestedAt)}
            </span>
          </p>
          <div>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setShowCancelConfirm(true)}
              className="tag-label !text-red hover:!text-red-ink disabled:opacity-50"
            >
              Cancel pickup
            </button>
          </div>
        </div>
      )}

      {!active && (
        <div className="flex flex-col gap-2">
          {request?.status === "cancelled" && (
            <p className="text-xs text-ink-faint font-condensed">
              Previous pickup {request.dispatchConfirmationNumber} was cancelled
              {request.cancelledAt ? ` ${formatDbTimestamp(request.cancelledAt)}` : ""}.
            </p>
          )}
          {request?.status === "failed" && request.errorMessage && (
            <p className="text-xs text-red-ink font-condensed">Last attempt failed: {request.errorMessage}</p>
          )}
          <div>
            <button
              type="button"
              disabled={isPending}
              onClick={openScheduleDialog}
              className="btn px-4 py-2 bg-orange text-paper disabled:opacity-50"
            >
              {isPending ? "Checking…" : "Schedule DHL Pickup"}
            </button>
          </div>
        </div>
      )}

      {previewError && (
        <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{previewError}</p>
      )}
      {error && (
        <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>
      )}

      {showConfirm && preview && (
        <ConfirmDialog
          title="Schedule this DHL pickup?"
          message={`This books a real pickup with DHL — a truck will be dispatched.\n\n${preview.parcelCount} parcel(s), ~${preview.totalWeightLb} lb (estimated, packages aren't individually weighed)\nReady: ${preview.plannedPickupDateAndTime}\nClose: ${preview.closeTime}\nAddress: ${preview.address}`}
          confirmLabel="Schedule pickup"
          onCancel={() => setShowConfirm(false)}
          onConfirm={confirmSchedule}
        />
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title="Cancel this DHL pickup?"
          message="This cancels the pickup with DHL. If this pickup was consolidated with other shipments' pickups, cancelling may cancel the whole consolidated pickup, not just this one — confirm with DHL if unsure."
          confirmLabel="Cancel pickup"
          danger
          onCancel={() => setShowCancelConfirm(false)}
          onConfirm={confirmCancel}
        />
      )}
    </div>
  );
}
