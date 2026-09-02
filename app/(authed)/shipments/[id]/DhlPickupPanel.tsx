"use client";

import { useState, useTransition } from "react";
import type { PickupRequestRecord, PreviewPickup } from "@/lib/dhl-pickup";
import { previewPickupAction, schedulePickupAction, cancelPickupAction } from "./dhl-pickup-actions";
import ConfirmDialog from "../../ConfirmDialog";
import Toast from "../../Toast";
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
  const [showScheduledToast, setShowScheduledToast] = useState(false);
  const [isPending, startTransition] = useTransition();

  const active = request?.status === "requested";

  // Desktop: these two collapse into the button's own `title` tooltip
  // instead of a separate inline message, now that the button sits inline
  // with the session id row rather than having a row of its own to spare.
  // Mobile keeps the floating paragraph versions below (native title
  // tooltips don't work on touch).
  const cancelButtonTitle =
    active && request?.dispatchConfirmationNumber
      ? `Scheduled by ${request.requestedByName}${
          request.pickupDateLabel ? ` for ${request.pickupDateLabel} · ${request.readyTimeLabel}–${request.closeTimeLabel}` : ""
        } — confirmation ${request.dispatchConfirmationNumber}, ${request.parcelCount} parcel(s), ~${request.totalWeightLb} lb, requested ${formatDbTimestamp(request.requestedAt)}. Click to cancel.`
      : undefined;
  const scheduleButtonTitle =
    !active && request?.status === "cancelled"
      ? `Previous pickup was cancelled${request.cancelledAt ? ` ${formatDbTimestamp(request.cancelledAt)}` : ""}${
          request.cancelledByName ? ` by ${request.cancelledByName}` : ""
        }.`
      : !active && request?.status === "failed" && request.errorMessage
        ? `Last attempt failed: ${request.errorMessage}`
        : undefined;

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
          requestedByName: result.requestedByName,
          errorMessage: null,
          cancelledAt: null,
          cancelledByName: null,
          pickupDateLabel: result.pickupDateLabel,
          readyTimeLabel: result.readyTimeLabel,
          closeTimeLabel: result.closeTimeLabel,
        });
        setShowScheduledToast(true);
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
        setRequest((r) =>
          r
            ? {
                ...r,
                status: "cancelled",
                cancelledAt: new Date().toISOString(),
                cancelledByName: result.cancelledByName,
              }
            : r,
        );
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
          title={cancelButtonTitle}
          // Mobile: solid fill, no border — see ReopenButton for why
          // red-ink text alone didn't hold up against this bar's bg-ink.
          // Desktop keeps the original outline pill, unchanged.
          className="btn inline-flex flex-col md:flex-row items-center justify-center gap-1.5 md:gap-1 px-3 md:px-4 py-3.5 md:py-2 bg-red text-paper hover:bg-red-ink md:bg-transparent md:border md:border-red md:text-red-ink md:hover:bg-red-dim disabled:opacity-50 flex-1 md:flex-none md:shrink-0"
        >
          <XCircleIcon className="w-7 h-7 md:hidden" />
          <span className="hidden md:inline">Cancel Pickup</span>
        </button>
      ) : schedulingEnabled ? (
        <button
          type="button"
          disabled={isPending}
          onClick={openScheduleDialog}
          title={scheduleButtonTitle}
          className="btn inline-flex flex-col md:flex-row items-center justify-center gap-1.5 md:gap-1 px-3 md:px-4 py-3.5 md:py-2 bg-orange text-paper hover:bg-orange-ink disabled:opacity-50 flex-1 md:flex-none md:shrink-0"
        >
          <TruckIcon className="w-7 h-7 md:hidden" />
          <span className="hidden md:inline">{isPending ? "Checking…" : "Schedule DHL Pickup"}</span>
        </button>
      ) : (
        // Floats flush on top of the fixed tab bar on mobile (same pattern
        // as the status messages below) instead of sitting inline as a
        // washed-out filler where the button would be — amber-dim gives it
        // a background distinct from both the page and the dark bar so it
        // actually reads as a message, not empty space. Desktop keeps the
        // original plain inline line.
        <p className="absolute bottom-full left-0 right-0 md:static text-xs text-amber-ink font-condensed w-full text-center bg-amber-dim md:bg-transparent px-3 py-2 md:px-0 md:py-0">
          DHL pickup scheduling is currently disabled by an admin.
        </p>
      )}

      {/* absolute here floats these flush on top of the mobile tab bar (its
          fixed parent's box, no gap) instead of squeezing in as extra tabs.
          md:hidden drops them entirely on desktop — see cancelButtonTitle/
          scheduleButtonTitle above, which carry the same info as a tooltip
          on the button itself now that it sits inline with the session id
          row instead of having its own row underneath to show them in. */}
      {active && request?.pickupDateLabel && (
        <p className="absolute bottom-full left-0 right-0 md:hidden text-xs text-orange-ink font-condensed w-full text-center bg-orange-dim px-3 py-2">
          Pickup scheduled by {request.requestedByName} for {request.pickupDateLabel} · {request.readyTimeLabel}–{request.closeTimeLabel}
        </p>
      )}
      {!active && request?.status === "cancelled" && (
        <p className="absolute bottom-full left-0 right-0 md:hidden text-xs text-ink-faint font-condensed w-full text-center bg-paper-dim px-3 py-2">
          Pickup was cancelled
          {request.cancelledAt ? ` ${formatDbTimestamp(request.cancelledAt)}` : ""}
          {request.cancelledByName ? ` by ${request.cancelledByName}` : ""}.
        </p>
      )}
      {!active && request?.status === "failed" && request.errorMessage && (
        <p className="absolute bottom-full left-0 right-0 md:hidden text-xs text-red-ink font-condensed w-full text-center bg-red-dim px-3 py-2">
          Last attempt failed: {request.errorMessage}
        </p>
      )}
      {previewError && (
        <p className="absolute bottom-full left-0 right-0 md:static border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm w-full">
          {previewError}
        </p>
      )}
      {error && (
        <p className="absolute bottom-full left-0 right-0 md:static border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm w-full">
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

      {showScheduledToast && (
        <Toast message="DHL pickup scheduled" onDismiss={() => setShowScheduledToast(false)} />
      )}
    </>
  );
}
