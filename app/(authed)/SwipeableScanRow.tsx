"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanRow } from "@/lib/shiplog";
import { CARRIER_COLOR, CARRIER_SHORT_LABEL, timeAgo } from "./ScanClient";
import ConfirmDialog from "./ConfirmDialog";
import { CopyIcon, CheckIcon } from "./icons";

// Same thresholds as SwipeableShipmentRow (shipments/SwipeableShipmentRow.tsx)
// — one consistent "how hard is a hard swipe" feel across the app.
const HARD_SWIPE_PX = 96;
const MAX_DRAG_PX = 140;

/** Real parcel weight, from ShipStation — null renders nothing, same "omit, don't blank" convention as shipments/[id]/ScanTable.tsx's own formatWeight. */
function formatWeight(lb: number | null): string | null {
  return lb === null ? null : `${lb} lb`;
}

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
  unmatchedIsStale,
  showWeight,
  onOpenOrder,
  onUndo,
}: {
  scan: ScanRow;
  scannedByName: string;
  isFlashing: boolean;
  // Computed by the parent rather than here: escalation needs a ticking
  // clock, and one in ScanClient covers the whole manifest instead of every
  // row owning a timer. Keeps this component presentational.
  unmatchedIsStale: boolean;
  // Admin-editable (lib/display-settings.ts, toggled on /admin/users) —
  // same setting that hides shipments/[id]/ScanTable.tsx's weight stamp.
  showWeight: boolean;
  onOpenOrder: (orderGid: string) => void;
  onUndo: (scanId: string) => void;
}) {
  const weight = showWeight ? formatWeight(s.shipstationWeightLb) : null;
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const touchState = useRef<TouchState | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
    };
  }, []);

  async function copyTrackingNumber() {
    try {
      await navigator.clipboard.writeText(s.trackingNumber);
    } catch {
      return;
    }
    setCopied(true);
    if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
    copiedTimeout.current = setTimeout(() => setCopied(false), 1500);
  }
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
        {/* Not a <button> — it needs to contain the copy button below, and a
            button can't nest another interactive control. role="button" +
            tabIndex/onKeyDown keep it keyboard-operable like the button it
            replaced; the "disabled" (no orderGid) case just omits the
            handlers instead of an HTML disabled attribute. */}
        <div
          role={s.orderGid ? "button" : undefined}
          tabIndex={s.orderGid ? 0 : undefined}
          onClick={() => {
            if (suppressNextClick.current) {
              suppressNextClick.current = false;
              return;
            }
            if (s.orderGid) onOpenOrder(s.orderGid);
          }}
          onKeyDown={(e) => {
            if (!s.orderGid) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenOrder(s.orderGid);
            }
          }}
          className="flex-1 flex flex-col items-start text-left min-w-0"
        >
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span className="data text-sm truncate">{s.trackingNumber}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                copyTrackingNumber();
              }}
              aria-label={copied ? "Tracking number copied" : "Copy tracking number"}
              title={copied ? "Copied!" : "Copy tracking number"}
              className={`shrink-0 p-1 -m-1 ${copied ? "text-green-ink" : "text-ink-faint hover:text-ink"}`}
            >
              {copied ? <CheckIcon className="w-3.5 h-3.5" /> : <CopyIcon className="w-3.5 h-3.5" />}
            </button>
          </span>
          {/* Always a second line, matching height regardless of carrier or
              match status — a row that skipped this line when unmatched
              (EPG only, previously) made the manifest list visibly uneven. */}
          {s.orderName ? (
            <span className="text-xs text-blue hover:underline">{s.orderName}</span>
          ) : unmatchedIsStale ? (
            /* §9c.4 — past the point where webhook lag still explains it, an
               unmatched tracking number is a mis-scan or the wrong label on
               the parcel, and the bench is the last place that's cheap to
               fix. Muted grey reads as "not yet"; this has to read as "check
               this one." The glyph carries the same signal as the color so
               it doesn't rest on red alone. */
            <span className="text-xs text-red font-semibold">⚠ no order match — check label</span>
          ) : (
            <span className="text-xs text-ink-faint">no order match yet</span>
          )}
        </div>
        {s.boxNumber && <span className="tag-label">BOX {String(s.boxNumber).padStart(2, "0")}</span>}
        {/* Desktop-only, same reasoning as scannedByName/timeAgo just below
            — not essential to a packer's next tap, and the row is already
            tight on a narrow screen. */}
        {weight && <span className="hidden sm:inline tag-label !normal-case !tracking-normal !text-ink-faint">{weight}</span>}
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
