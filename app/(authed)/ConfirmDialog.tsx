"use client";

import { createPortal } from "react-dom";
import { useDismissable } from "./useDismissable";

/**
 * Themed stand-in for window.confirm() — same corners/bg-paper-panel modal
 * shell as OrderPanel/SubmitDialog/CommandPalette, so destructive actions
 * (Reset Day, deleting a shipment) don't drop into a bare OS dialog that
 * breaks the "Freight Manifest" look.
 *
 * Portaled to document.body rather than rendered in place: several call
 * sites (SwipeableScanRow's Undo, the shipment detail page's mobile action
 * bar) live inside an ancestor with `position: fixed` of its own — the
 * scan page's manifest panel, the mobile tab bar. iOS Safari has a
 * long-standing bug where a `position: fixed` element nested inside
 * another `fixed` ancestor gets positioned relative to that ancestor's
 * box instead of the true viewport, clipping this dialog to whatever
 * sliver of screen the ancestor occupies instead of covering the whole
 * screen. A portal sidesteps the bug entirely by not being DOM-nested
 * inside that ancestor in the first place, regardless of which call site
 * renders it.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useDismissable(onCancel);
  return createPortal(
    <div className="fixed inset-0 bg-ink/60 flex items-center justify-center p-4 z-30" onClick={onCancel}>
      <div
        className="corners bg-paper-panel text-ink p-6 max-w-md w-full flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="route-line pb-3">
          <h2 className="font-stencil text-xl tracking-wide">{title}</h2>
        </div>
        <div className="text-sm font-condensed whitespace-pre-wrap">{message}</div>
        <div className="flex items-center gap-3 justify-end">
          <button type="button" onClick={onCancel} className="tag-label hover:!text-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`btn px-4 py-2 ${danger ? "bg-red text-paper hover:bg-red-ink" : "bg-orange text-paper"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
