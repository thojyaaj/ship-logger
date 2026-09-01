"use client";

import { useState, useTransition } from "react";
import type { PickupRequestRecord, PreviewPickup } from "@/lib/dhl-pickup";
import { previewPickupAction, schedulePickupAction, cancelPickupAction } from "./dhl-pickup-actions";
import ConfirmDialog from "../../ConfirmDialog";
import { formatDbTimestamp } from "@/lib/date";
import { actionErrorMessage } from "@/lib/error-message";
import { TruckIcon, XCircleIcon } from "./icons";

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
  schedulingEnabled,
}: {
  sessionId: string;
  initialRequest: PickupRequestRecord | null;
  schedulingEnabled: boolean;
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
    <>
      {active && request?.dispatchConfirmationNumber ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => setShowCancelConfirm(true)}
          title={`Confirmation ${request.dispatchConfirmationNumber} — ${request.parcelCount} parcel(s), ~${request.totalWeightLb} lb, requested ${formatDbTimestamp(request.requestedAt)}. Click to cancel.`}
          className="btn inline-flex flex-col md:flex-row items-center justify-center gap-1 px-3 md:px-4 py-2 border border-red text-red-ink hover:bg-red-dim disabled:opacity-50 flex-1 md:flex-none md:shrink-0"
        >
          <XCircleIcon className="w-5 h-5 md:hidden" />
          <span className="hidden md:inline">Cancel Pickup · {request.dispatchConfirmationNumber}</span>
        </button>
      ) : schedulingEnabled ? (
        <button
          type="button"
          disabled={isPending}
          onClick={openScheduleDialog}
          className="btn inline-flex flex-col md:flex-row items-center justify-center gap-1 px-3 md:px-4 py-2 bg-orange text-paper disabled:opacity-50 flex-1 md:flex-none md:shrink-0"
        >
          <TruckIcon className="w-5 h-5 md:hidden" />
          <span className="hidden md:inline">{isPending ? "Checking…" : "Schedule DHL Pickup"}</span>
        </button>
      ) : (
        <p className="text-xs text-ink-faint font-condensed w-full text-center">
          DHL pickup scheduling is currently disabled by an admin.
        </p>
      )}

      {/* absolute here floats these above the mobile tab bar (its fixed
          parent's box) instead of squeezing in as extra tabs; md:static
          reverts to plain inline messages under the buttons on desktop. */}
      {!active && request?.status === "cancelled" && (
        <p className="absolute bottom-full left-0 right-0 mb-2 md:static md:mb-0 text-xs text-ink-faint font-condensed w-full text-center bg-paper-panel md:bg-transparent px-3 py-2 md:px-0 md:py-0">
          Previous pickup {request.dispatchConfirmationNumber} was cancelled
          {request.cancelledAt ? ` ${formatDbTimestamp(request.cancelledAt)}` : ""}.
        </p>
      )}
      {!active && request?.status === "failed" && request.errorMessage && (
        <p className="absolute bottom-full left-0 right-0 mb-2 md:static md:mb-0 text-xs text-red-ink font-condensed w-full text-center bg-red-dim px-3 py-2">
          Last attempt failed: {request.errorMessage}
        </p>
      )}
      {previewError && (
        <p className="absolute bottom-full left-0 right-0 mb-2 md:static md:mb-0 border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm w-full">
          {previewError}
        </p>
      )}
      {error && (
        <p className="absolute bottom-full left-0 right-0 mb-2 md:static md:mb-0 border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm w-full">
          {error}
        </p>
      )}

      {showConfirm && preview && (
        <ConfirmDialog
          title="Schedule this DHL pickup?"
          message={
            <>
              This books a real pickup with DHL — a truck will be dispatched.
              <span className="block text-base font-semibold text-ink mt-3">
                {preview.pickupDateLabel}
              </span>
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
    </>
  );
}
