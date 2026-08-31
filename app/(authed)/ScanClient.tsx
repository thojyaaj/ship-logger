"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { SessionDashboard } from "@/lib/shiplog";
import type { SessionUser } from "@/lib/auth";
import { carrierLabel, type Carrier } from "@/lib/carrier";
import { parseDbTimestamp } from "@/lib/date";
import {
  scanAction,
  undoScanAction,
  createBoxAction,
  setActiveBoxAction,
  removeEmptyBoxAction,
} from "./scan-actions";
import SubmitDialog from "./SubmitDialog";

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

const CARRIER_COLOR: Record<Carrier, string> = {
  epg: "bg-orange-dim text-orange-ink",
  ups: "bg-blue-dim text-blue-ink",
  dhl: "bg-amber-dim text-amber-ink",
  unknown: "bg-paper-dim text-ink-soft",
};

const CARRIER_ACCENT: Record<Carrier, string> = {
  epg: "text-orange",
  ups: "text-blue",
  dhl: "text-amber",
  unknown: "text-ink-faint",
};

type ToneKind = "accept" | "duplicate" | "checksum_warning" | "unrecognized" | "blocked";

// Each error kind gets a genuinely different sound, not just "warning" for
// everything — a packer looking at the box, not the screen, needs to tell
// "already scanned, fine" apart from "stop, this already shipped" by ear.
// Pleasant tones use a sine wave; error tones use a buzzier square wave, and
// severity increases with note count/duration (§8.4).
const TONES: Record<ToneKind, { freqs: number[]; wave: OscillatorType; gain: number; step: number }> = {
  accept: { freqs: [1568, 2093], wave: "sine", gain: 0.3, step: 0.08 },
  duplicate: { freqs: [1046, 1046], wave: "sine", gain: 0.3, step: 0.1 },
  // Sawtooth is the brightest/harshest standard waveform — full harmonic
  // series vs. triangle's mellow, fast-decaying one — hence "sharper."
  checksum_warning: { freqs: [1200, 700], wave: "sawtooth", gain: 0.4, step: 0.1 },
  unrecognized: { freqs: [900, 500, 900, 500], wave: "square", gain: 0.4, step: 0.1 },
  // Siren wail: fast alternation over a wide range, loudest and longest of
  // the set — this is the one blocking a mis-scan from shipping again (§8.4b).
  blocked: { freqs: [1400, 700, 1400, 700, 1400, 700], wave: "square", gain: 0.45, step: 0.09 },
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
  initialDashboard: SessionDashboard;
  currentUser: SessionUser;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [value, setValue] = useState("");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [flashScanId, setFlashScanId] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const keyTimestamps = useRef<number[]>([]);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const focusInput = useCallback(() => {
    // Never steal focus back while the submit dialog (or any future overlay)
    // is open — otherwise every click into its fields gets immediately
    // yanked back to this input via onBlur, and typing lands here instead.
    if (showSubmit) return;
    inputRef.current?.focus();
  }, [showSubmit]);

  useEffect(() => {
    focusInput();
  }, [focusInput]);

  const submitScan = useCallback(
    (raw: string, opts?: { forceCarrier?: Carrier; overrideChecksum?: boolean; forcePastDuplicate?: boolean }) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      setValue("");
      keyTimestamps.current = [];
      startTransition(async () => {
        const result = await scanAction(dashboard.session.id, trimmed, opts);
        switch (result.status) {
          case "ok": {
            setDashboard(result.dashboard);
            setBanner(null);
            const newest = result.dashboard.scans[0];
            if (newest) {
              setFlashScanId(newest.id);
              setTimeout(() => setFlashScanId(null), 600);
            }
            playTone("accept");
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
        focusInput();
      });
    },
    [dashboard.session.id, focusInput],
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
    startTransition(async () => {
      const updated = await undoScanAction(dashboard.session.id, scanId);
      setDashboard(updated);
      focusInput();
    });
  }

  function newBox() {
    startTransition(async () => {
      const updated = await createBoxAction(dashboard.session.id);
      setDashboard(updated);
      focusInput();
    });
  }

  function activateBox(boxId: string) {
    startTransition(async () => {
      const updated = await setActiveBoxAction(dashboard.session.id, boxId);
      setDashboard(updated);
      focusInput();
    });
  }

  function removeBox(boxId: string) {
    startTransition(async () => {
      const updated = await removeEmptyBoxAction(dashboard.session.id, boxId);
      setDashboard(updated);
      focusInput();
    });
  }

  const boxCountSum = dashboard.boxes.reduce((a, b) => a + b.scanCount, 0);
  const boxSumMismatch = dashboard.boxes.length > 0 && boxCountSum !== dashboard.totals.epg;

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-baseline justify-between route-line pb-2">
        <span className="tag-label">Session {dashboard.session.id.slice(0, 8)}</span>
        <span className="tag-label">{dashboard.session.shipDate}</span>
      </div>

      {/* Row 1 — per-carrier totals (§8.6), styled as instrument readouts */}
      <div className="grid grid-cols-4 gap-px bg-line">
        {(["epg", "ups", "dhl"] as const).map((c) => (
          <div key={c} className="corners bg-paper-panel p-4 text-center">
            <div className={`tag-label ${CARRIER_ACCENT[c]}`}>{carrierLabel(c)}</div>
            <div className="data text-4xl font-semibold mt-1">{dashboard.totals[c]}</div>
          </div>
        ))}
        <div className="corners bg-ink text-paper p-4 text-center">
          <div className="tag-label !text-orange">Session Total</div>
          <div className="data text-4xl font-semibold mt-1">{dashboard.totals.total}</div>
        </div>
      </div>

      {/* Row 2 — EPG box chips (§8.6) */}
      <div className="flex flex-wrap items-center gap-2">
        {dashboard.boxes.map((b) => (
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
          className="data px-4 py-2 font-semibold text-base border border-dashed border-line-strong text-ink-soft hover:border-ink hover:text-ink"
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
            onBlur={focusInput}
            autoFocus
            placeholder="Scan or type a tracking number, then press Enter"
            className="data flex-1 text-2xl px-4 py-4 bg-paper-panel focus:bg-white outline-none placeholder:text-ink-faint placeholder:text-base placeholder:font-condensed"
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
        <h2 className="tag-label">Manifest — {dashboard.scans.length} scanned</h2>
        <ul className="flex flex-col border-t border-line">
          {dashboard.scans.map((s) => (
            <li
              key={s.id}
              className={`flex items-center gap-3 px-3 py-2.5 border-b border-line transition-colors ${
                flashScanId === s.id ? "bg-green-dim" : "bg-paper-panel"
              }`}
            >
              <span className={`tag-label !text-[0.6rem] px-1.5 py-1 ${CARRIER_COLOR[s.carrier]}`}>
                {carrierLabel(s.carrier)}
              </span>
              <span className="data text-sm flex-1">{s.trackingNumber}</span>
              {s.boxNumber && (
                <span className="tag-label">BOX {String(s.boxNumber).padStart(2, "0")}</span>
              )}
              <span className="tag-label !normal-case !tracking-normal !text-ink-soft">
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
          {dashboard.scans.length === 0 && (
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
          disabled={dashboard.totals.total === 0}
          className="btn w-full py-4 bg-orange text-paper text-xl disabled:opacity-30"
        >
          Submit Shipment →
        </button>
      </div>

      {showSubmit && (
        <SubmitDialog
          dashboard={dashboard}
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => {
            window.location.reload();
          }}
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
