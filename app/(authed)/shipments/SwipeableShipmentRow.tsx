"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { statusTone } from "@/lib/carrier";
import type { ShipmentListItem } from "@/lib/shiplog";
import { deleteShipmentAction } from "../scan-actions";
import { actionErrorMessage } from "@/lib/error-message";

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
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
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
    if (!isAdmin || !showSwipeHint) return;
    const t1 = setTimeout(() => setDragX(-56), 500);
    const t2 = setTimeout(() => setDragX(0), 1100);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isAdmin, showSwipeHint]);

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
        commitDelete();
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
    // A drag that never crossed the "this was intentional" threshold — even
    // one that snapped back — shouldn't also navigate; only a genuine tap
    // (no meaningful movement at all) opens the shipment.
    if (isDragging || dragX !== 0) return;
    router.push(`/shipments/${s.id}`);
  }

  if (removed) return null;

  return (
    <div className="relative border-b border-line overflow-hidden">
      {isAdmin && (
        <div className="absolute inset-0 bg-red flex items-center justify-end px-6">
          <span className="tag-label !text-paper">Delete</span>
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
          isDragging ? "" : "transition-transform duration-300 ease-out"
        } ${deleting ? "opacity-0" : ""}`}
      >
        <div className="flex items-center gap-2 sm:block sm:w-28 sm:shrink-0">
          <div className="data font-semibold">{s.shipDate}</div>
          <span
            className={`tag-label !text-[0.6rem] px-1.5 py-0.5 inline-block sm:mt-0.5 ${
              s.status === "submitted" ? "bg-green-dim !text-green-ink" : "bg-amber-dim !text-amber-ink"
            }`}
          >
            {s.status}
          </span>
        </div>
        <div className="flex-1 flex flex-wrap gap-x-4 gap-y-1 text-sm data">
          <span className="text-orange">EPG {s.totals.epg}</span>
          <span className="text-blue">UPS {s.totals.ups}</span>
          <span className="text-amber">DHL {s.totals.dhl}</span>
          {s.boxCount > 0 && <span className="text-ink-soft">{s.boxCount} box(es)</span>}
        </div>
        <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-1 sm:shrink-0 sm:text-right">
          {s.awbNumber && <span className="tag-label !normal-case">{s.awbNumber}</span>}
          {s.totals.epg > 0 && s.masterUpsTracking && (
            <span
              title={`Master UPS ${s.masterUpsTracking}${s.masterUpsStatusAt ? ` — as of ${s.masterUpsStatusAt}` : ""}`}
              className={`tag-label !text-[0.6rem] px-1.5 py-0.5 inline-block whitespace-nowrap ${statusTone(s.masterUpsStatusLabel)}`}
            >
              {s.masterUpsStatusLabel ?? "STATUS PENDING"}
            </span>
          )}
        </div>
      </div>
      {error && (
        <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>
      )}
    </div>
  );
}
