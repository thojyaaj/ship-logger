"use client";

import { createPortal } from "react-dom";
import { useDismissable } from "../../useDismissable";
import { XCircleIcon } from "../../shipments/[id]/icons";

/**
 * One label/value line inside DetailModal — the full-detail view for a row
 * whose mobile card only has room for a tracking number and one headline
 * figure (see ExceptionsClient.tsx's mobile card layout).
 */
export function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="tag-label !text-[0.6rem] shrink-0">{label}</span>
      <span className="data text-sm text-right break-words">{value}</span>
    </div>
  );
}

/**
 * Portaled detail sheet for a mobile exceptions-page card — everything the
 * desktop table shows in its extra columns, surfaced behind one tap on the
 * info icon instead of being crammed into the card itself. Same portal +
 * backdrop-click + Escape shell as ConfirmDialog (see its own comment on why
 * a portal, not a bare fixed div, is needed here).
 */
export default function DetailModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useDismissable(onClose);
  return createPortal(
    <div className="fixed inset-0 bg-ink/60 flex items-center justify-center p-4 z-30" onClick={onClose}>
      <div
        className="corners bg-paper-panel text-ink p-5 max-w-sm w-full flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 route-line pb-2">
          <h2 className="font-stencil text-base tracking-wide break-all pr-2">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink shrink-0">
            <XCircleIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="flex flex-col gap-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
