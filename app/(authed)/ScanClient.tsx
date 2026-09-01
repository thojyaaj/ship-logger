"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import type { SessionDashboard } from "@/lib/shiplog";
import type { SessionUser } from "@/lib/auth";
import { carrierLabel, type Carrier } from "@/lib/carrier";
import { parseDbTimestamp, localCalendarDate } from "@/lib/date";
import {
  scanAction,
  undoScanAction,
  createBoxAction,
  setActiveBoxAction,
  removeEmptyBoxAction,
  resetSessionAction,
} from "./scan-actions";
import SubmitDialog from "./SubmitDialog";
import OrderPanel from "./OrderPanel";
import ConfirmDialog from "./ConfirmDialog";
import { useCommandPaletteState } from "./CommandPaletteState";
import { actionErrorMessage } from "@/lib/error-message";
import { withTransportRetry } from "@/lib/with-retry";

type Banner =
  | { kind: "unrecognized"; trackingNumber: string }
  | { kind: "checksum_warning"; trackingNumber: string; carrier: Carrier; reason: string }
  | { kind: "duplicate_in_session"; trackingNumber: string; boxNumber: number | null }
  | {
      kind: "duplicate_previous_shipment";
      trackingNumber: string;
      shipDate: string;
      boxNumber: number | null;
      scannedByName: string;
      sessionSubmitted: boolean;
    }
  | { kind: "error"; message: string };

// `!` is required on every color here: `.tag-label`'s own `color` rule lives
// outside any Tailwind `@layer` in globals.css, so per the CSS cascade-layers
// spec it beats ANY layered utility class (including a same-specificity
// `.text-orange`) regardless of source order — without `!important` these
// silently render as tag-label's default ink-faint gray instead of the
// intended carrier color, which is why every other accent color in this app
// already uses the `!` prefix.
const CARRIER_COLOR: Record<Carrier, string> = {
  epg: "bg-orange-dim !text-orange-ink",
  ups: "bg-blue-dim !text-blue-ink",
  dhl: "bg-amber-dim !text-amber-ink",
  unknown: "bg-paper-dim !text-ink-soft",
};

const CARRIER_ACCENT: Record<Carrier, string> = {
  epg: "!text-orange",
  ups: "!text-blue",
  dhl: "!text-amber",
  unknown: "!text-ink-faint",
};

const CARRIER_TINT: Record<Carrier, string> = {
  epg: "bg-orange-dim",
  ups: "bg-blue-dim",
  dhl: "bg-amber-dim",
  unknown: "bg-paper-dim",
};

// carrierLabel()'s full "ePost Global" is right for the manual
// carrier-assignment banner and CSV export, where an operator needs to read
// an unambiguous name. At instrument-tile/badge width it's more than twice
// UPS/DHL's length, which threw off the totals grid on a phone (that one
// tile's label nearly touched its edges while its neighbors had room to
// spare) and shifted the manifest's tracking-number column per row. Fixed
// three-letter codes here match the Shipments Log's EPG/UPS/DHL convention.
const CARRIER_SHORT_LABEL: Record<Carrier, string> = {
  epg: "EPG",
  ups: "UPS",
  dhl: "DHL",
  unknown: "Unknown",
};

type ToneKind =
  | "accept_epg"
  | "accept_ups"
  | "accept_dhl"
  | "duplicate"
  | "checksum_warning"
  | "unrecognized"
  | "blocked";

// Each error kind gets a genuinely different sound, not just "warning" for
// everything — a packer looking at the box, not the screen, needs to tell
// "already scanned, fine" apart from "stop, this already shipped" by ear.
// Pleasant tones use a sine wave; error tones use a buzzier square wave, and
// severity increases with note count/duration (§8.4).
//
// Accept tones are split per carrier so a packer can hear *which* courier
// just got scanned without looking up — each is a calm sine chime (neutral,
// not alarming) but shaped differently (register + note count) so the three
// are easy to tell apart by ear, not just by pitch.
const TONES: Record<ToneKind, { freqs: number[]; wave: OscillatorType; gain: number; step: number }> = {
  accept_epg: { freqs: [1568, 2093], wave: "sine", gain: 0.3, step: 0.08 },
  accept_ups: { freqs: [1319, 1760], wave: "sine", gain: 0.3, step: 0.09 },
  accept_dhl: { freqs: [1175, 1568, 1976], wave: "sine", gain: 0.3, step: 0.06 },
  duplicate: { freqs: [1046, 1046], wave: "sine", gain: 0.3, step: 0.1 },
  // Sawtooth is the brightest/harshest standard waveform — full harmonic
  // series vs. triangle's mellow, fast-decaying one — hence "sharper."
  checksum_warning: { freqs: [1200, 700], wave: "sawtooth", gain: 0.4, step: 0.1 },
  unrecognized: { freqs: [900, 500, 900, 500], wave: "square", gain: 0.4, step: 0.1 },
  // Deliberately ugly "wrong buzzer": low, dissonant (near-tritone) sawtooth
  // alternation — the opposite register and timbre of the accept chimes
  // above, so it reads as unmistakably bad, not just "another notification."
  // This is the one blocking a mis-scan from shipping again (§8.4b).
  blocked: { freqs: [196, 138, 196, 138, 196, 138], wave: "sawtooth", gain: 0.5, step: 0.1 },
};

// A successful scan's carrier is always a real courier, never "unknown"
// (that path returns "unrecognized" instead) — the fallback here only
// guards against that invariant changing, so it never goes silent.
const ACCEPT_TONE_BY_CARRIER: Record<Carrier, ToneKind> = {
  epg: "accept_epg",
  ups: "accept_ups",
  dhl: "accept_dhl",
  unknown: "accept_epg",
};

function playTone(kind: ToneKind) {
  if (typeof window === "undefined") return;
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const { freqs, wave, gain: gainLevel, step } = TONES[kind];
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(gainLevel, ctx.currentTime);
    let t = ctx.currentTime;
    osc.frequency.setValueAtTime(freqs[0], t);
    osc.start(t);
    freqs.forEach((f, i) => {
      if (i > 0) {
        t += step;
        osc.frequency.setValueAtTime(f, t);
      }
    });
    osc.stop(t + step);
    osc.onended = () => ctx.close();
  } catch {
    // Audio isn't critical to the app functioning — ignore failures silently.
  }
}

function timeAgo(dbTimestamp: string): string {
  const diff = Date.now() - parseDbTimestamp(dbTimestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

export default function ScanClient({
  initialDashboard,
  currentUser,
}: {
  initialDashboard: SessionDashboard | null;
  currentUser: SessionUser;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [value, setValue] = useState("");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [flashScanId, setFlashScanId] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [openOrderGid, setOpenOrderGid] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const keyTimestamps = useRef<number[]>([]);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { open: paletteOpen } = useCommandPaletteState();

  // Monotonic id for dashboard-mutating requests. Every server response
  // carries a full dashboard snapshot, so an older response landing after a
  // newer one silently rewinds the manifest — scan A and scan B in flight
  // together, A resolves second, and B disappears from the list even though
  // it committed. Applying a snapshot only when its request is still the
  // newest also fixes the mirror-image bug on the rollback paths, where a
  // failed action restored a `previous` captured before a *later* action had
  // already succeeded.
  const requestSeq = useRef(0);
  const beginRequest = useCallback(() => {
    const id = ++requestSeq.current;
    return () => id === requestSeq.current;
  }, []);

  const overlayOpen = Boolean(showSubmit || openOrderGid || showResetConfirm || paletteOpen);
  const overlayOpenRef = useRef(overlayOpen);
  // useLayoutEffect, not useEffect: this ref is read from a setTimeout
  // scheduled in onBlur. Layout effects flush synchronously on commit, so the
  // ref is already current by the time that macrotask runs; a passive effect
  // is not guaranteed to be.
  useLayoutEffect(() => {
    overlayOpenRef.current = overlayOpen;
  }, [overlayOpen]);

  const focusInput = useCallback(() => {
    // Never steal focus back while the submit dialog, order panel, reset
    // confirmation, or command palette is open — otherwise every
    // click/keystroke into their fields gets immediately yanked back to
    // this input via onBlur.
    //
    // Reads a ref rather than the captured state values: onBlur fires before
    // the click that caused it has updated state, so a closure captured at
    // render time still sees every overlay as closed. Deferring the call
    // alone (setTimeout) didn't fix that — it deferred *when* the stale
    // closure ran, not *what* it saw.
    if (overlayOpenRef.current) return;
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!overlayOpen) inputRef.current?.focus();
  }, [overlayOpen]);

  // Any pending scanner-burst timer must not outlive the component — it would
  // fire submitScan for an unmounted screen after a mid-scan navigation.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const submitScan = useCallback(
    (raw: string, opts?: { forceCarrier?: Carrier; overrideChecksum?: boolean; forcePastDuplicate?: boolean }) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      setValue("");
      keyTimestamps.current = [];
      const isNewest = beginRequest();
      startTransition(async () => {
        try {
          const result = await withTransportRetry(() =>
            scanAction(dashboard?.session.id ?? null, trimmed, opts),
          );
          switch (result.status) {
            case "ok": {
              // The tone and the accepted-scan flash always fire — this scan
              // really did commit, and the packer is listening for that. Only
              // the full-dashboard write is gated, because a snapshot from an
              // older in-flight request would drop a newer scan from the list.
              // A newer request's snapshot already contains this one.
              if (isNewest()) {
                setDashboard(result.dashboard);
                setBanner(null);
                const newest = result.dashboard.scans[0];
                if (newest) {
                  setFlashScanId(newest.id);
                  setTimeout(() => setFlashScanId(null), 600);
                }
              }
              playTone(ACCEPT_TONE_BY_CARRIER[result.carrier]);
              break;
            }
            case "unrecognized":
              playTone("unrecognized");
              setBanner({ kind: "unrecognized", trackingNumber: result.trackingNumber });
              break;
            case "checksum_warning":
              playTone("checksum_warning");
              setBanner({
                kind: "checksum_warning",
                trackingNumber: result.trackingNumber,
                carrier: result.carrier,
                reason: result.reason,
              });
              break;
            case "duplicate_in_session":
              playTone("duplicate");
              // withTransportRetry wraps this call, and recordScan is not
              // idempotent: if the first attempt committed but its response was
              // dropped, the retry sees the row it just wrote and reports a
              // duplicate. The scan really is recorded, so refresh from the
              // server rather than leaving the manifest missing a parcel the
              // packer just scanned.
              if (result.dashboard && isNewest()) setDashboard(result.dashboard);
              setBanner({
                kind: "duplicate_in_session",
                trackingNumber: result.trackingNumber,
                boxNumber: result.boxNumber,
              });
              setTimeout(() => setBanner((b) => (b?.kind === "duplicate_in_session" ? null : b)), 4000);
              break;
            case "duplicate_previous_shipment":
              playTone("blocked");
              setBanner({
                kind: "duplicate_previous_shipment",
                trackingNumber: result.trackingNumber,
                shipDate: result.shipDate,
                boxNumber: result.boxNumber,
                scannedByName: result.scannedByName,
                sessionSubmitted: result.sessionSubmitted,
              });
              break;
          }
        } catch (err) {
          // A thrown scanAction (e.g. the session was voided out from under
          // this scan by a concurrent Reset Day, or a race on box creation)
          // must never silently swallow the tracking number — a packer
          // watching the parcel, not the screen, needs a loud signal that
          // this one didn't record, not a scan that vanishes with no trace.
          playTone("blocked");
          const message = actionErrorMessage(err, "Scan failed — please rescan.");
          setBanner({ kind: "error", message: `"${trimmed}" — ${message}` });
          // Only refill the input if the packer hasn't already moved on to
          // scanning something else while this request was in flight.
          setValue((current) => (current.trim() ? current : trimmed));
        }
        focusInput();
      });
    },
    [dashboard?.session.id, focusInput, beginRequest],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    keyTimestamps.current.push(Date.now());
    if (e.key === "Enter") {
      e.preventDefault();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      submitScan(value);
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setValue(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    // Fallback for scanners that don't send a trailing Enter: if the recent
    // keystrokes arrived in a fast burst (scanner speed, not human typing)
    // and input goes quiet for 200ms, auto-submit. See PRD §8.3 / research
    // on keyboard-wedge scanners.
    debounceTimer.current = setTimeout(() => {
      const stamps = keyTimestamps.current;
      if (next.length < 6 || stamps.length < 4) return;
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (avgGap < 50) submitScan(next);
    }, 200);
  }

  function undo(scanId: string) {
    if (!dashboard) return;
    const sessionId = dashboard.session.id;
    const previous = dashboard;
    const isNewest = beginRequest();
    const target = previous.scans.find((s) => s.id === scanId);
    if (!target) return;
    setDashboard((d) => {
      if (!d) return d;
      return {
        ...d,
        scans: d.scans.filter((s) => s.id !== scanId),
        totals: { ...d.totals, [target.carrier]: d.totals[target.carrier] - 1, total: d.totals.total - 1 },
        boxes: target.boxId
          ? d.boxes.map((b) => (b.id === target.boxId ? { ...b, scanCount: b.scanCount - 1 } : b))
          : d.boxes,
      };
    });
    startTransition(async () => {
      try {
        const updated = await withTransportRetry(() => undoScanAction(sessionId, scanId));
        if (isNewest()) setDashboard(updated);
      } catch (err) {
        // Only roll back if nothing newer has landed — `previous` predates any
        // action the packer took while this one was in flight, so restoring it
        // unconditionally would silently undo their newer, successful change.
        if (isNewest()) setDashboard(previous);
        playTone("blocked");
        setBanner({ kind: "error", message: actionErrorMessage(err, "Undo failed — please retry.") });
      }
      focusInput();
    });
  }

  function newBox() {
    if (!dashboard) return;
    const isNewest = beginRequest();
    startTransition(async () => {
      try {
        const updated = await createBoxAction(dashboard.session.id);
        if (isNewest()) setDashboard(updated);
      } catch (err) {
        // Previously unguarded: two packers pressing "New Box" at the same
        // instant collide on the unique (session, box_number) index, and the
        // loser's rejection surfaced as the button simply doing nothing.
        playTone("blocked");
        setBanner({ kind: "error", message: actionErrorMessage(err, "Couldn't add a box — please retry.") });
      }
      focusInput();
    });
  }

  function activateBox(boxId: string) {
    if (!dashboard) return;
    const sessionId = dashboard.session.id;
    const previous = dashboard;
    const isNewest = beginRequest();
    setDashboard((d) => (d ? { ...d, session: { ...d.session, activeBoxId: boxId } } : d));
    startTransition(async () => {
      try {
        const updated = await withTransportRetry(() => setActiveBoxAction(sessionId, boxId));
        if (isNewest()) setDashboard(updated);
      } catch (err) {
        if (isNewest()) setDashboard(previous);
        playTone("blocked");
        setBanner({ kind: "error", message: actionErrorMessage(err, "Couldn't switch box — please retry.") });
      }
      focusInput();
    });
  }

  function removeBox(boxId: string) {
    if (!dashboard) return;
    const sessionId = dashboard.session.id;
    const previous = dashboard;
    const isNewest = beginRequest();
    setDashboard((d) =>
      d
        ? {
            ...d,
            boxes: d.boxes.filter((b) => b.id !== boxId),
            session: d.session.activeBoxId === boxId ? { ...d.session, activeBoxId: null } : d.session,
          }
        : d,
    );
    startTransition(async () => {
      try {
        const updated = await withTransportRetry(() => removeEmptyBoxAction(sessionId, boxId));
        if (isNewest()) setDashboard(updated);
      } catch (err) {
        if (isNewest()) setDashboard(previous);
        playTone("blocked");
        setBanner({ kind: "error", message: actionErrorMessage(err, "Couldn't remove box — please retry.") });
      }
      focusInput();
    });
  }

  function confirmResetDay() {
    if (!dashboard) return;
    setShowResetConfirm(false);
    const isNewest = beginRequest();
    startTransition(async () => {
      try {
        const updated = await resetSessionAction(dashboard.session.id);
        if (isNewest()) {
          setDashboard(updated);
          setBanner(null);
        }
      } catch (err) {
        // Reset Day wipes the session; failing it silently left the packer
        // believing the day had been cleared when it hadn't.
        playTone("blocked");
        setBanner({ kind: "error", message: actionErrorMessage(err, "Reset failed — please retry.") });
      }
      focusInput();
    });
  }

  const boxCountSum = (dashboard?.boxes ?? []).reduce((a, b) => a + b.scanCount, 0);
  const boxSumMismatch = !!dashboard && dashboard.boxes.length > 0 && boxCountSum !== dashboard.totals.epg;

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-baseline justify-between route-line pb-2">
        <span className="tag-label">Session {dashboard ? dashboard.session.id.slice(0, 8) : "—"}</span>
        <div className="flex items-baseline gap-4">
          <span className="tag-label">{dashboard?.session.shipDate ?? localCalendarDate()}</span>
          {dashboard && (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="tag-label !text-red hover:!text-red-ink"
              title="Discard all of today's scans and start over"
            >
              Reset Day
            </button>
          )}
        </div>
      </div>

      {/* Row 1 — per-carrier totals (§8.6), styled as instrument readouts.
          2 columns on a phone — 4-across at that width squeezes text-4xl
          numbers into ~70px cells. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line">
        {(["epg", "ups", "dhl"] as const).map((c) => (
          <div key={c} className={`corners p-4 text-center ${CARRIER_TINT[c]}`}>
            <div className={`tag-label ${CARRIER_ACCENT[c]}`}>{CARRIER_SHORT_LABEL[c]}</div>
            <div className="data text-4xl font-semibold mt-1">{dashboard?.totals[c] ?? 0}</div>
          </div>
        ))}
        <div className="corners bg-ink text-paper p-4 text-center">
          <div className="tag-label !text-orange">Session Total</div>
          <div className="data text-4xl font-semibold mt-1">{dashboard?.totals.total ?? 0}</div>
        </div>
      </div>

      {/* Row 2 — EPG box chips (§8.6) */}
      <div className="flex flex-wrap items-center gap-2">
        {dashboard &&
          dashboard.boxes.map((b) => (
            <div key={b.id} className="flex items-stretch">
              <button
                type="button"
                onClick={() => activateBox(b.id)}
                className={`data px-4 py-2 font-semibold text-base border ${
                  dashboard.session.activeBoxId === b.id
                    ? "border-orange bg-orange text-paper"
                    : "border-line-strong bg-paper-panel text-ink hover:border-ink"
                }`}
              >
                BOX {String(b.boxNumber).padStart(2, "0")} <span className="opacity-60">·</span> {b.scanCount}
              </button>
              {b.scanCount === 0 && (
                <button
                  type="button"
                  onClick={() => removeBox(b.id)}
                  title="Remove empty box"
                  className={`px-2 border border-l-0 text-sm ${
                    dashboard.session.activeBoxId === b.id
                      ? "border-orange bg-orange text-paper"
                      : "border-line-strong bg-paper-panel text-ink-soft"
                  }`}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        <button
          type="button"
          onClick={newBox}
          disabled={!dashboard}
          title={dashboard ? undefined : "Scan a parcel first to start today's shipment"}
          className="data px-4 py-2 font-semibold text-base border border-dashed border-line-strong text-ink-soft hover:border-ink hover:text-ink disabled:opacity-30 disabled:hover:border-line-strong disabled:hover:text-ink-soft"
        >
          + New Box
        </button>
        {boxSumMismatch && (
          <span className="text-red font-semibold text-sm ml-2 data">
            ⚠ Box counts ({boxCountSum}) ≠ EPG total ({dashboard.totals.epg})
          </span>
        )}
      </div>

      {/* Scan input. A hardware scanner types into this like a keyboard and
          ends with Enter (§8.3) — the button is a manual-entry fallback for
          testing and for typing a number in by hand. */}
      <div className="flex flex-col gap-2">
        <span className="tag-label">Scan input</span>
        <div className="corners flex gap-px bg-line">
          <input
            ref={inputRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            // Deferred to the next macrotask so the click that caused the blur
            // can land first: refocusing synchronously during blur cancels the
            // pending click outright on touch devices, which read as "tapping
            // an order just scrolls back to the input" instead of opening the
            // panel. focusInput itself reads overlay state from a ref, so by
            // the time this runs it sees the click's committed state rather
            // than the stale closure it would otherwise have captured.
            onBlur={() => setTimeout(focusInput, 0)}
            autoFocus
            placeholder="Scan or type a tracking number, then press Enter"
            // min-w-0 overrides a flex item's default min-width:auto — without
            // it, this input refuses to shrink below its content's intrinsic
            // width and pushes the row past a phone's viewport (measured
            // 422px content in a 375px viewport before this).
            className="data flex-1 min-w-0 text-2xl px-4 py-4 bg-paper-panel focus:bg-white outline-none placeholder:text-ink-faint placeholder:text-base placeholder:font-condensed"
          />
          <button
            type="button"
            onClick={() => submitScan(value)}
            disabled={!value.trim()}
            className="btn px-6 bg-ink text-paper text-lg disabled:opacity-30"
          >
            Add
          </button>
        </div>
        {isPending && <span className="text-sm text-ink-faint data">PROCESSING…</span>}
      </div>

      {/* Banners */}
      {banner && (
        <BannerView
          banner={banner}
          isAdmin={currentUser.isAdmin}
          onDismiss={() => setBanner(null)}
          onAssignCarrier={(carrier) => {
            const tn = "trackingNumber" in banner ? banner.trackingNumber : "";
            submitScan(tn, { forceCarrier: carrier });
          }}
          onUseAnyway={() => {
            if (banner.kind !== "checksum_warning") return;
            submitScan(banner.trackingNumber, { overrideChecksum: true });
          }}
          onForcePastDuplicate={() => {
            if (banner.kind !== "duplicate_previous_shipment") return;
            submitScan(banner.trackingNumber, { forcePastDuplicate: true });
          }}
        />
      )}

      {/* Scan list */}
      <div className="flex-1 flex flex-col gap-1 min-h-0">
        <h2 className="tag-label">Manifest — {dashboard?.scans.length ?? 0} scanned</h2>
        <ul className="flex flex-col border-t border-line">
          {dashboard &&
            dashboard.scans.map((s) => (
              <li
                key={s.id}
                className={`flex items-center gap-3 px-3 py-2.5 border-b border-line transition-colors ${
                  flashScanId === s.id ? "bg-green-dim" : "bg-paper-panel"
                }`}
              >
                <span
                  className={`tag-label !text-[0.6rem] px-1.5 py-1 w-12 shrink-0 text-center ${CARRIER_COLOR[s.carrier]}`}
                >
                  {CARRIER_SHORT_LABEL[s.carrier]}
                </span>
                <button
                  type="button"
                  onClick={() => s.orderGid && setOpenOrderGid(s.orderGid)}
                  disabled={!s.orderGid}
                  className="flex-1 flex flex-col items-start text-left min-w-0"
                >
                  <span className="data text-sm">{s.trackingNumber}</span>
                  {s.orderName ? (
                    <span className="text-xs text-blue hover:underline">{s.orderName}</span>
                  ) : s.carrier === "ups" || s.carrier === "dhl" ? (
                    <span className="text-xs text-ink-faint">no order match yet</span>
                  ) : null}
                </button>
                {s.boxNumber && (
                  <span className="tag-label">BOX {String(s.boxNumber).padStart(2, "0")}</span>
                )}
                {/* Who/when is useful context but not essential to a packer's
                    next tap — dropped on narrow screens so the tracking number
                    and Undo button (the two things actually needed mid-pack)
                    keep real room instead of getting squeezed. */}
                <span className="hidden sm:inline tag-label !normal-case !tracking-normal !text-ink-soft">
                  {dashboard.userNames[s.scannedBy] ?? "?"} · {timeAgo(s.scannedAt)}
                </span>
                <button
                  type="button"
                  onClick={() => undo(s.id)}
                  className="tag-label !text-red hover:!text-red-ink"
                >
                  Undo
                </button>
              </li>
            ))}
          {(!dashboard || dashboard.scans.length === 0) && (
            <li className="text-ink-faint text-sm py-8 text-center border-b border-line data">
              NO SCANS YET
            </li>
          )}
        </ul>
      </div>

      <div className="sticky bottom-0 bg-paper pt-2 pb-4 route-line">
        <button
          type="button"
          onClick={() => setShowSubmit(true)}
          disabled={!dashboard || dashboard.totals.total === 0}
          className="btn w-full py-4 bg-orange text-paper text-xl disabled:opacity-30"
        >
          Submit Shipment →
        </button>
      </div>

      {showSubmit && dashboard && (
        <SubmitDialog
          dashboard={dashboard}
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => {
            window.location.reload();
          }}
        />
      )}

      {openOrderGid && <OrderPanel orderGid={openOrderGid} onClose={() => setOpenOrderGid(null)} />}

      {showResetConfirm && dashboard && (
        <ConfirmDialog
          title="Reset today's session?"
          message={
            dashboard.totals.total > 0
              ? `This permanently discards all ${dashboard.totals.total} scanned tracking number${dashboard.totals.total === 1 ? "" : "s"} and starts a fresh session. This cannot be undone.`
              : "Start a fresh session for today?"
          }
          confirmLabel="Reset Day"
          danger
          onConfirm={confirmResetDay}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
    </div>
  );
}

function BannerView({
  banner,
  isAdmin,
  onDismiss,
  onAssignCarrier,
  onUseAnyway,
  onForcePastDuplicate,
}: {
  banner: Banner;
  isAdmin: boolean;
  onDismiss: () => void;
  onAssignCarrier: (carrier: Carrier) => void;
  onUseAnyway: () => void;
  onForcePastDuplicate: () => void;
}) {
  if (banner.kind === "unrecognized") {
    return (
      <div className="border-l-4 border-red bg-red-dim p-4 flex flex-col gap-2">
        <p className="font-semibold text-red-ink">
          &ldquo;{banner.trackingNumber}&rdquo; — not a recognized EPG/UPS/DHL tracking number.
        </p>
        <div className="flex gap-2 items-center flex-wrap">
          <span className="tag-label !text-red-ink">Assign carrier:</span>
          {(["epg", "ups", "dhl"] as const).map((c) => (
            <button
              key={c}
              onClick={() => onAssignCarrier(c)}
              className="btn px-3 py-1.5 bg-paper-panel border border-red text-red-ink hover:bg-white"
            >
              {carrierLabel(c)}
            </button>
          ))}
          <button onClick={onDismiss} className="tag-label !text-red-ink ml-auto">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (banner.kind === "checksum_warning") {
    return (
      <div className="border-l-4 border-amber bg-amber-dim p-4 flex items-center gap-3 flex-wrap">
        <p className="font-semibold text-amber-ink flex-1">
          &ldquo;{banner.trackingNumber}&rdquo; — {banner.reason} Looks like a misread — rescan?
        </p>
        <button
          onClick={onUseAnyway}
          className="btn px-3 py-1.5 bg-paper-panel border border-amber text-amber-ink hover:bg-white"
        >
          Use anyway
        </button>
        <button onClick={onDismiss} className="tag-label !text-amber-ink">
          Dismiss
        </button>
      </div>
    );
  }

  if (banner.kind === "duplicate_in_session") {
    return (
      <div className="border-l-4 border-line-strong bg-paper-dim px-4 py-2.5 text-ink-soft text-sm data">
        ALREADY SCANNED{banner.boxNumber ? ` — BOX ${String(banner.boxNumber).padStart(2, "0")}` : ""}
      </div>
    );
  }

  if (banner.kind === "duplicate_previous_shipment") {
    return (
      <div className="border-l-4 border-red bg-red-dim p-4 flex flex-col gap-3">
        <p className="font-bold text-red-ink text-lg leading-snug">
          ⚠ Already shipped {banner.shipDate}
          {banner.boxNumber ? `, Box ${banner.boxNumber}` : ""} — scanned by {banner.scannedByName}
          {!banner.sessionSubmitted ? " (still open)" : ""}.
        </p>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <button
              onClick={onForcePastDuplicate}
              className="btn px-3 py-1.5 bg-red text-paper hover:bg-red-ink"
            >
              Force add anyway (admin)
            </button>
          )}
          <button onClick={onDismiss} className="tag-label !text-red-ink ml-auto">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-l-4 border-red bg-red-dim p-4 text-red-ink">
      {banner.message}
    </div>
  );
}
