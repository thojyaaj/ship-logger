"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * A single self-dismissing confirmation banner — not a stacking toast
 * system (no queue, no multiple-at-once handling), since every call site
 * today only ever has one thing to confirm at a time. Add a queue if a
 * second concurrent use case shows up; building it now would be
 * speculative.
 *
 * Portaled to document.body — its one call site (DhlPickupPanel) renders
 * from inside the shipment detail page's mobile action bar, itself
 * `position: fixed`. See ConfirmDialog's comment for why a `fixed`
 * element nested inside another `fixed` ancestor can't just render in
 * place on iOS Safari.
 */
export default function Toast({
  message,
  onDismiss,
  durationMs = 3500,
}: {
  message: string;
  onDismiss: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [onDismiss, durationMs]);

  return createPortal(
    <div
      role="status"
      // Clears the mobile shipment-detail tab bar (bottom-20) and the scan
      // page's fixed footer alike; md: drops to a plain corner toast since
      // neither of those fixed bars exist in desktop's normal document flow.
      className="fixed bottom-20 md:bottom-6 inset-x-4 md:inset-x-auto md:right-6 z-50 flex justify-center md:justify-end pointer-events-none"
    >
      <div className="pointer-events-auto corners bg-ink text-paper px-4 py-3 shadow-lg flex items-center gap-2 max-w-sm">
        <span className="w-2 h-2 rounded-full bg-orange shrink-0" />
        <span className="text-sm font-condensed">{message}</span>
      </div>
    </div>,
    document.body,
  );
}
