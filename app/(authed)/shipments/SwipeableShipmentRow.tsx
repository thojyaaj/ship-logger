"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { statusTone } from "@/lib/carrier";
import { formatCarrierTimestamp } from "@/lib/date";
import type { ShipmentListItem } from "@/lib/shiplog";
import { deleteShipmentAction } from "../scan-actions";
import { actionErrorMessage } from "@/lib/error-message";
import ConfirmDialog from "../ConfirmDialog";

// A drag past this many px counts as a committed "hard swipe" — deletes
// immediately on release, no second confirm tap. Below it, the row just
// snaps back. Fixed pixel effort rather than a fraction of row width: a
// phone-width row and a tablet-width row should take the same physical
// swipe distance to commit, not a proportionally different one.
const HARD_SWIPE_PX = 96;
// Visual clamp while actively dragging — keeps the red backdrop from
// stretching past what a thumb could plausibly pull it.
const MAX_DRAG_PX = 140;
// Far enough to clear any phone width — used only for the slide-away
// animation once a delete has actually committed.
const SLIDE_AWAY_PX = 480;

type TouchState = {
  startX: number;
  startY: number;
  dx: number;
  decided: boolean;
  horizontal: boolean;
};

/**
 * Swipe-to-delete row for the shipments log — touch-only (mouse users get a
 * plain click-to-navigate row; there's nothing to attach the gesture to for
 * them), and admin-only since deleteShipmentAction is admin-gated server-side
 * anyway — showing the affordance to a packer who can't actually use it would
 * just be confusing.
 */
export default function SwipeableShipmentRow({
  shipment: s,
  isAdmin,
  showSwipeHint,
}: {
  shipment: ShipmentListItem;
  isAdmin: boolean;
  showSwipeHint: boolean;
}) {
  const router = useRouter();
  // The open session is a hard server-side no — trashShipment() throws for
  // it rather than touching the DB (see lib/shiplog.ts) — so this is known
  // up front rather than discovered via a failed round-trip.
  const isOpenSession = s.status === "open";
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const touchState = useRef<TouchState | null>(null);
  // Set the instant a touch sequence is decided as a horizontal drag —
  // read (and cleared) by handleClick so the browser's synthetic click
  // that can still follow a touch gesture never falls through to
  // navigation, regardless of any state-update/render timing race.
  const suppressNextClick = useRef(false);

  // One-time peek on load so a first-time visitor discovers the gesture
  // exists at all — nudges the first row left and back, revealing a sliver
  // of the delete backdrop, then never runs again for this mount.
  useEffect(() => {
    // isOpenSession is a defensive backstop, not the primary guard — the
    // parent (shipments/page.tsx) already targets the hint at the first
    // deletable row, but the "open session is always index 0" assumption
    // it relies on isn't a hard guarantee (shipDate ties can reorder the
    // list), so this never peeks on an undeletable row even if that slips.
    // Desktop is excluded too: the gesture itself is already touch-only
    // (mouse users get a plain click-to-navigate row, see below), but this
    // hint is just a setTimeout-driven dragX nudge with no touch-input
    // dependency — it would play on a mouse-only desktop just as readily,
    // demoing a gesture nobody there can actually perform. sm: (640px) is
    // this component's own mobile/desktop split (see the row layout below),
    // matched here rather than reaching for a different breakpoint.
    if (!isAdmin || !showSwipeHint || isOpenSession) return;
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches) return;
    const t1 = setTimeout(() => setDragX(-56), 500);
    const t2 = setTimeout(() => setDragX(0), 1100);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isAdmin, showSwipeHint, isOpenSession]);

  async function startDelete() {
    try {
      await deleteShipmentAction(s.id);
      // router.refresh() re-fetches the list from the server, which can
      // reconcile this row out of existence well before the 220ms
      // slide-away transition finishes — cutting the animation short and
      // shifting the rows below it up abruptly mid-flight. Deferred until
      // after the animation completes instead of firing immediately.
      setTimeout(() => {
        setRemoved(true);
        router.refresh();
      }, 220);
    } catch (err) {
      setDeleting(false);
      setDragX(0);
      setError(actionErrorMessage(err, "Failed to delete shipment."));
    }
  }

  function commitDelete() {
    setError(null);
    setDeleting(true);
    setDragX(-SLIDE_AWAY_PX);
    startDelete();
  }

  // Skips the round-trip entirely — the server would just throw — and
  // gives immediate, unmistakable feedback instead of a snap-back plus an
  // easy-to-miss inline error, which is what made this read as a glitch.
  function rejectDelete() {
    setDragX(0);
    setShaking(true);
    setError("This is today's open session — use Reset Day on the scan page to clear it instead.");
    setTimeout(() => setShaking(false), 500);
  }

  // touchmove needs a real (non-passive) listener to be able to
  // preventDefault the page's vertical scroll once a horizontal drag is
  // underway — React's JSX onTouchMove is registered passive for scroll
  // performance, so e.preventDefault() inside it is silently ignored.
  useEffect(() => {
    if (!isAdmin) return;
    const el = rowRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      if (deleting) return;
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
          // A vertical scroll gesture — let the browser handle it natively
          // and stop tracking this touch as a swipe candidate.
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
      // preventDefault on touchmove is supposed to already suppress the
      // browser's compatibility click for this touch sequence, but that's
      // inconsistent enough across browsers in practice that a drag could
      // still end in a real click landing on this element — belt-and-
      // braces it here too, plus the ref flag below that handleClick checks
      // directly instead of trusting suppression alone.
      e.preventDefault();
      suppressNextClick.current = true;
      if (ts.dx <= -HARD_SWIPE_PX) {
        if (isOpenSession) {
          rejectDelete();
        } else {
          // A hard swipe opens the same confirm dialog the detail page's
          // Delete button does — it doesn't commit anything on its own. The
          // row snaps back to rest immediately rather than staying pulled
          // open behind the dialog.
          setDragX(0);
          setShowConfirm(true);
        }
      } else {
        setDragX(0);
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, deleting]);

  function handleClick() {
    if (suppressNextClick.current) {
      suppressNextClick.current = false;
      return;
    }
    // A drag that never crossed the "this was intentional" threshold — even
    // one that snapped back — shouldn't also navigate; only a genuine tap
    // (no meaningful movement at all) opens the shipment.
    if (isDragging || dragX !== 0) return;
    router.push(`/shipments/${s.id}`);
  }

  if (removed) return null;

  return (
    <>
      <div className="relative border-b border-line overflow-hidden">
        {isAdmin && (
          <div
            className={`absolute inset-0 flex items-center justify-end px-6 ${isOpenSession ? "bg-amber" : "bg-red"}`}
          >
            <span className="tag-label !text-paper">{isOpenSession ? "Can't Delete" : "Delete"}</span>
          </div>
        )}
        <div
          ref={rowRef}
          role="link"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(e) => {
            if (e.key === "Enter") router.push(`/shipments/${s.id}`);
          }}
          style={{ transform: `translateX(${dragX}px)` }}
          className={`relative flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3 bg-paper-panel hover:bg-white transition-colors cursor-pointer ${
            shaking ? "shake-x" : isDragging ? "" : "transition-transform duration-300 ease-out"
          } ${deleting ? "opacity-0" : ""}`}
        >
          {/* Mobile: session id left, status pushed to the far right (justify-
              between + w-full) instead of bunched together on the left.
              sm:block overrides both back to the original stacked column
              on desktop, where justify-between/w-full have no effect.
              Widened from the original w-28 to fit "submitted · <ship
              date>" on one line — whitespace-nowrap on the tag backs that
              up rather than letting it wrap to two lines if a row's exact
              content ever runs long. */}
          <div className="flex items-center justify-between gap-2 w-full sm:block sm:w-48 sm:shrink-0">
            <div className="data font-semibold" title={s.id}>
              {s.id.slice(0, 8).toUpperCase()}
              {s.status === "submitted" && s.submittedByCode ? `-${s.submittedByCode}` : ""}
            </div>
            <span
              className={`tag-label !text-[0.6rem] px-1.5 py-0.5 inline-block whitespace-nowrap sm:mt-0.5 ${
                s.status === "submitted" ? "bg-green-dim !text-green-ink" : "bg-amber-dim !text-amber-ink"
              }`}
            >
              {s.status === "submitted" ? `${s.status} · ${s.shipDate}` : s.status}
            </span>
          </div>
          {/* Mobile: explicit full width so the courier counts always span
              the row edge-to-edge; sm:w-auto hands sizing back to flex-1
              (share of the row alongside the session id/status and AWB/
              tracking columns) on desktop. sm:justify-center spreads them
              into the extra room the wider first column leaves behind
              instead of leaving them bunched against it. */}
          <div className="flex-1 flex flex-wrap gap-x-4 gap-y-1 text-sm data w-full sm:w-auto sm:justify-center">
            <span className="text-orange">EPG {s.totals.epg}</span>
            <span className="text-blue">UPS {s.totals.ups}</span>
            <span className="text-amber">DHL {s.totals.dhl}</span>
            {s.boxCount > 0 && <span className="text-ink-soft">{s.boxCount} box(es)</span>}
          </div>
          <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-1 sm:shrink-0 sm:text-right">
            {s.awbNumber && <span className="tag-label !normal-case">AWB {s.awbNumber}</span>}
            {s.totals.epg > 0 && s.masterUpsTracking && (
              <span
                title={`Master UPS ${s.masterUpsTracking}${s.masterUpsStatusAt ? ` — as of ${formatCarrierTimestamp(s.masterUpsStatusAt)}` : ""}`}
                className={`tag-label !text-[0.6rem] px-1.5 py-0.5 inline-block whitespace-nowrap ${statusTone(s.masterUpsStatusLabel)}`}
              >
                {s.masterUpsStatusLabel ?? "STATUS PENDING"}
              </span>
            )}
          </div>
        </div>
      </div>
      {/* Outside the overflow-hidden/relative row wrapper on purpose — the
          backdrop's inset-0 stretches to cover this container's full
          height (including this message, if it were inside), painting
          over the error text since positioned descendants paint above
          normal-flow ones in the same stacking context. */}
      {error && (
        <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>
      )}

      {showConfirm && (
        <ConfirmDialog
          title="Delete this shipment?"
          message={`This moves the ${s.shipDate} shipment to Trash. It can be restored from the Trash page within 30 days, after which it's permanently deleted.`}
          confirmLabel="Move to Trash"
          danger
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => {
            setShowConfirm(false);
            commitDelete();
          }}
        />
      )}
    </>
  );
}
