"use client";

/**
 * Themed stand-in for window.confirm() — same corners/bg-paper-panel modal
 * shell as OrderPanel/SubmitDialog/CommandPalette, so destructive actions
 * (Reset Day, deleting a shipment) don't drop into a bare OS dialog that
 * breaks the "Freight Manifest" look.
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
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-ink/60 flex items-center justify-center p-4 z-30" onClick={onCancel}>
      <div
        className="corners bg-paper-panel text-ink p-6 max-w-md w-full flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="route-line pb-3">
          <h2 className="font-stencil text-xl tracking-wide">{title}</h2>
        </div>
        <p className="text-sm font-condensed whitespace-pre-wrap">{message}</p>
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
    </div>
  );
}
