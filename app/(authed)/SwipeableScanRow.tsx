"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanRow } from "@/lib/shiplog";
import { CARRIER_COLOR, CARRIER_SHORT_LABEL, timeAgo } from "./ScanClient";
import ConfirmDialog from "./ConfirmDialog";

// Same thresholds as SwipeableShipmentRow (shipments/SwipeableShipmentRow.tsx)
// — one consistent "how hard is a hard swipe" feel across the app.
const HARD_SWIPE_PX = 96;
const MAX_DRAG_PX = 140;

type TouchState = {
  startX: number;
  startY: number;
  dx: number;
  decided: boolean;
  horizontal: boolean;
};

/**
 * Swipe-to-undo for a manifest row — touch-only, available to every user
 * (undoScanAction has no admin gate, unlike shipment deletion) since any
 * packer can already undo their own or a teammate's scan via the existing
 * Undo button. The swipe is just a faster path to the same confirm step the
 * button takes — both park the row and ask before actually calling onUndo,
 * since undoing the wrong scan mid-pack is an easy accidental tap/swipe.
 */
export default function SwipeableScanRow({
  scan: s,
  scannedByName,
  isFlashing,
  onOpenOrder,
  onUndo,
}: {
  scan: ScanRow;
  scannedByName: string;
  isFlashing: boolean;
  onOpenOrder: (orderGid: string) => void;
  onUndo: (scanId: string) => void;
}) {
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const touchState = useRef<TouchState | null>(null);
  // Set the instant a touch sequence is decided as a horizontal drag — the
  // Order/Undo buttons check (and clear) this so a browser-synthesized
  // click that can still follow a touch-drag never falls through to
  // opening the order panel or undoing a second time.
  const suppressNextClick = useRef(false);

  // Real (non-passive) touchmove listener, same reasoning as
  // SwipeableShipmentRow: JSX's onTouchMove is passive, so
  // e.preventDefault() inside it can't actually stop page scroll once a
  // horizontal drag is underway.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      // The flag only means "the click immediately following the touch
      // sequence that's about to start should be suppressed" — clearing it
      // fresh here scopes it to that one gesture. Left set from a previous
      // drag, it would permanently block every future tap on this row: once
      // touchend's preventDefault actually succeeds in suppressing the
      // browser's synthetic click (the common case), nothing else ever
      // clears it back to false.
      suppressNextClick.current = false;
      const t = e.touches[0];
      touchState.current = { startX: t.clientX, startY: t.clientY, dx: 0, decided: false, horizontal: false };
      setIsDragging(true);
    }

    function onTouchMove(e: TouchEvent) {
      const ts = touchState.current;
      if (!ts) return;
      const t = e.touches[0];
      const dx = t.clientX - ts.startX;
      const dy = t.clientY - ts.startY;
      if (!ts.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        ts.decided = true;
        ts.horizontal = Math.abs(dx) > Math.abs(dy);
        if (!ts.horizontal) {
          touchState.current = null;
          setIsDragging(false);
          return;
        }
      }
      if (!ts.horizontal) return;
      e.preventDefault();
      const clamped = Math.min(0, Math.max(dx, -MAX_DRAG_PX));
      ts.dx = clamped;
      setDragX(clamped);
    }

    function onTouchEnd(e: TouchEvent) {
      const ts = touchState.current;
      touchState.current = null;
      setIsDragging(false);
      if (!ts || !ts.horizontal) return;
      // Belt-and-braces against a synthetic click still following this
      // touch sequence — see the matching comment in SwipeableShipmentRow.
      e.preventDefault();
      suppressNextClick.current = true;
      // Either way the row snaps back to rest immediately — a hard swipe
      // just opens the same confirm dialog the Undo button does, it doesn't
      // commit anything on its own.
      setDragX(0);
      if (ts.dx <= -HARD_SWIPE_PX) setShowConfirm(true);
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [s.id, onUndo]);

  return (
    <li className="relative border-b border-line overflow-hidden">
      <div className="absolute inset-0 bg-red flex items-center justify-end px-6">
        <span className="tag-label !text-paper">Undo</span>
      </div>
      <div
        ref={rowRef}
        style={{ transform: `translateX(${dragX}px)` }}
        className={`relative flex items-center gap-3 px-3 py-2.5 transition-colors ${
          flashScanRowBg(isFlashing)
        } ${isDragging ? "" : "transition-transform duration-300 ease-out"}`}
      >
        <span
          className={`tag-label !text-[0.6rem] px-1.5 py-1 w-12 shrink-0 text-center ${CARRIER_COLOR[s.carrier]}`}
        >
          {CARRIER_SHORT_LABEL[s.carrier]}
        </span>
        <button
          type="button"
          onClick={() => {
            if (suppressNextClick.current) {
              suppressNextClick.current = false;
              return;
            }
            if (s.orderGid) onOpenOrder(s.orderGid);
          }}
          disabled={!s.orderGid}
          className="flex-1 flex flex-col items-start text-left min-w-0"
        >
          <span className="data text-sm">{s.trackingNumber}</span>
          {/* Always a second line, matching height regardless of carrier or
              match status — a row that skipped this line when unmatched
              (EPG only, previously) made the manifest list visibly uneven. */}
          {s.orderName ? (
            <span className="text-xs text-blue hover:underline">{s.orderName}</span>
          ) : (
            <span className="text-xs text-ink-faint">no order match yet</span>
          )}
        </button>
        {s.boxNumber && <span className="tag-label">BOX {String(s.boxNumber).padStart(2, "0")}</span>}
        {/* Who/when is useful context but not essential to a packer's next
            tap — dropped on narrow screens so the tracking number and Undo
            button (the two things actually needed mid-pack) keep real room
            instead of getting squeezed. */}
        <span className="hidden sm:inline tag-label !normal-case !tracking-normal !text-ink-soft">
          {scannedByName} · {timeAgo(s.scannedAt)}
        </span>
        <button
          type="button"
          onClick={() => {
            if (suppressNextClick.current) {
              suppressNextClick.current = false;
              return;
            }
            setShowConfirm(true);
          }}
          className="tag-label !text-red hover:!text-red-ink"
        >
          Undo
        </button>
      </div>

      {showConfirm && (
        <ConfirmDialog
          title="Undo this scan?"
          message={`Remove "${s.trackingNumber}" from this session's manifest?`}
          confirmLabel="Undo"
          danger
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => {
            setShowConfirm(false);
            // The parent's undo() removes this scan from dashboard.scans
            // synchronously (optimistic update), so this component just
            // unmounts on the next render — no local "removed" state needed.
            onUndo(s.id);
          }}
        />
      )}
    </li>
  );
}

function flashScanRowBg(isFlashing: boolean): string {
  return isFlashing ? "bg-green-dim" : "bg-paper-panel";
}
