"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ProblemScan, ShippingLossScan, ProblemCategory } from "@/lib/shipment-alerts";
import { carrierLabel, statusTone, type Carrier } from "@/lib/carrier";
import { formatCarrierTimestamp } from "@/lib/date";
import { dismissProblemAction } from "./actions";
import { useClickPopover } from "../../useClickPopover";
import { XCircleIcon, RotateCcwIcon, InfoIcon } from "../../shipments/[id]/icons";
import DetailModal, { DetailRow } from "./DetailModal";

const CARRIER_ORDER: Carrier[] = ["ups", "dhl", "epg"];

// How long an admin has to change their mind before a dismiss actually
// commits — see CountdownRing/scheduleDismiss below.
const DISMISS_DELAY_MS = 10_000;

function formatMoney(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

function rowKey(category: ProblemCategory, scanId: string): string {
  return `${category}:${scanId}`;
}

type CarrierRow = ProblemScan & { category: "exception" | "stale" };

/** A ring that empties over `durationMs`, purely via a CSS transition set once on mount — not a per-frame JS loop. */
function CountdownRing({ durationMs }: { durationMs: number }) {
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    // The effect already runs after React commits the initial (unfilled)
    // render to the DOM, so one rAF is enough to let the browser paint that
    // starting value before flipping it — the flip is then a real
    // transition, not a jump straight to the end state.
    const raf = requestAnimationFrame(() => setFilled(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const circumference = 2 * Math.PI * 8;
  return (
    <svg viewBox="0 0 20 20" className="w-4 h-4 -rotate-90 shrink-0" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={filled ? circumference : 0}
        style={{ transition: `stroke-dashoffset ${durationMs}ms linear` }}
      />
    </svg>
  );
}

/**
 * Client wrapper for /admin/exceptions — the server component (page.tsx)
 * just fetches and hands off; everything selection/dismiss related lives
 * here since it needs interaction state. router.refresh() after a
 * dismissal re-runs the server component with fresh data (same pattern as
 * SwipeableShipmentRow's delete, UsersClient, etc.) rather than hand-rolling
 * client-side list surgery.
 *
 * Dismissing is deferred, not immediate: clicking the dismiss icon starts a
 * 10s countdown (CountdownRing) during which the icon becomes a cancel/undo
 * button — only once the countdown finishes does the real server call
 * happen. A bulk "Dismiss selected" schedules the same per-row countdown
 * for every selected row independently, so cancelling one doesn't affect
 * the rest. If the tab is closed before the countdown finishes, the
 * dismissal simply never happens — this is a client-side deferral, not a
 * server-scheduled job, which is the right tradeoff for what's fundamentally
 * a "did you mean that" affordance, not a durable queue.
 */
export default function ExceptionsClient({
  exceptions,
  stale,
  losses,
}: {
  exceptions: ProblemScan[];
  stale: ProblemScan[];
  losses: ShippingLossScan[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [isPending, startTransition] = useTransition();

  // A scheduled dismiss is a plain browser timer, independent of React's
  // lifecycle — navigating away in-app (e.g. to "Dismissed history" below)
  // unmounts this component but does not itself stop the timer, so without
  // this it fires anyway and commits a dismissal the admin no longer has any
  // Cancel button to stop. Matches the "closing the tab" guarantee the
  // scheduleDismiss comment already documents, extended to cover navigation
  // too — both are "this component is gone," just via different mechanisms.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timeoutId of timers.values()) clearTimeout(timeoutId);
      timers.clear();
    };
  }, []);

  function toggle(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleAll(keys: string[], allSelected: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allSelected) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  function commitDismiss(key: string) {
    timersRef.current.delete(key);
    const [category, scanId] = key.split(":") as [ProblemCategory, string];
    startTransition(async () => {
      await dismissProblemAction(scanId, category);
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      router.refresh();
    });
  }

  function scheduleDismiss(key: string) {
    // A row mid-countdown can still be checkbox-selected (its selectability
    // isn't gated on pending state), so "select all" + "Dismiss selected" can
    // re-target a key already scheduled. Without this guard, that overwrites
    // timersRef's entry with a second timer while orphaning the first —
    // both eventually fire and both call dismissProblemAction.
    if (timersRef.current.has(key)) return;
    setPendingKeys((prev) => new Set(prev).add(key));
    const timeoutId = setTimeout(() => commitDismiss(key), DISMISS_DELAY_MS);
    timersRef.current.set(key, timeoutId);
  }

  function cancelDismiss(key: string) {
    const timeoutId = timersRef.current.get(key);
    if (timeoutId) clearTimeout(timeoutId);
    timersRef.current.delete(key);
    setPendingKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function dismissOne(scanId: string, category: ProblemCategory) {
    scheduleDismiss(rowKey(category, scanId));
  }

  function dismissSelected(keys: string[]) {
    keys.forEach(scheduleDismiss);
    setSelected((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.delete(k));
      return next;
    });
  }

  const byCarrier = new Map<Carrier, CarrierRow[]>();
  for (const carrier of CARRIER_ORDER) byCarrier.set(carrier, []);
  for (const item of exceptions) byCarrier.get(item.carrier)?.push({ ...item, category: "exception" });
  for (const item of stale) byCarrier.get(item.carrier)?.push({ ...item, category: "stale" });

  const total = exceptions.length + stale.length + losses.length;

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-2 route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Exceptions</h1>
        <div className="flex items-center gap-3">
          <Link href="/admin/exceptions/dismissed" className="tag-label !text-ink-faint hover:!text-ink underline">
            Dismissed history
          </Link>
          <span className="tag-label !text-ink-faint">{total} open</span>
        </div>
      </div>

      {total === 0 ? (
        <p className="text-ink-faint">No exceptions, stale parcels, or shipping losses right now.</p>
      ) : (
        <>
          {losses.length > 0 && (
            <Section
              title="Shipping losses — paid more than charged"
              titleClassName="!text-red-ink"
              rowKeys={losses.map((l) => rowKey("loss", l.id))}
              selected={selected}
              onToggleAll={toggleAll}
              onDismissSelected={dismissSelected}
              isPending={isPending}
            >
              <LossTable
                items={losses}
                selected={selected}
                pendingKeys={pendingKeys}
                onToggle={toggle}
                onDismiss={dismissOne}
                onCancel={cancelDismiss}
              />
            </Section>
          )}
          {CARRIER_ORDER.map((carrier) => {
            const rows = byCarrier.get(carrier)!;
            if (rows.length === 0) return null;
            return (
              <Section
                key={carrier}
                title={carrierLabel(carrier)}
                rowKeys={rows.map((r) => rowKey(r.category, r.id))}
                selected={selected}
                onToggleAll={toggleAll}
                onDismissSelected={dismissSelected}
                isPending={isPending}
              >
                <CarrierTable
                  items={rows}
                  selected={selected}
                  pendingKeys={pendingKeys}
                  onToggle={toggle}
                  onDismiss={dismissOne}
                  onCancel={cancelDismiss}
                />
              </Section>
            );
          })}
        </>
      )}
    </div>
  );
}

function Section({
  title,
  titleClassName,
  rowKeys,
  selected,
  onToggleAll,
  onDismissSelected,
  isPending,
  children,
}: {
  title: string;
  titleClassName?: string;
  rowKeys: string[];
  selected: Set<string>;
  onToggleAll: (keys: string[], allSelected: boolean) => void;
  onDismissSelected: (keys: string[]) => void;
  isPending: boolean;
  children: React.ReactNode;
}) {
  const selectedInSection = rowKeys.filter((k) => selected.has(k));
  const allSelected = rowKeys.length > 0 && selectedInSection.length === rowKeys.length;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className={`tag-label !text-base ${titleClassName ?? ""}`}>{title}</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-faint font-condensed cursor-pointer">
            <input type="checkbox" checked={allSelected} onChange={() => onToggleAll(rowKeys, allSelected)} />
            Select all
          </label>
          <button
            type="button"
            disabled={selectedInSection.length === 0 || isPending}
            onClick={() => onDismissSelected(selectedInSection)}
            className="btn flex items-center gap-1.5 px-2.5 py-1 text-xs bg-orange text-paper disabled:opacity-50"
          >
            <XCircleIcon className="w-3.5 h-3.5" />
            Dismiss selected ({selectedInSection.length})
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

/** The dismiss icon, or — while a countdown is running for this row — the ring plus a cancel/undo icon. Shared by both tables below. */
function DismissCell({ pending, onDismiss, onCancel }: { pending: boolean; onDismiss: () => void; onCancel: () => void }) {
  if (pending) {
    return (
      <div className="flex items-center justify-end gap-1.5">
        <CountdownRing durationMs={DISMISS_DELAY_MS} />
        <button type="button" onClick={onCancel} title="Cancel dismiss" aria-label="Cancel dismiss" className="text-ink-faint hover:text-ink">
          <RotateCcwIcon className="w-4 h-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <button type="button" onClick={onDismiss} title="Dismiss" aria-label="Dismiss" className="text-ink-faint hover:text-red-ink">
        <XCircleIcon className="w-4 h-4" />
      </button>
    </div>
  );
}

function LossTable({
  items,
  selected,
  pendingKeys,
  onToggle,
  onDismiss,
  onCancel,
}: {
  items: ShippingLossScan[];
  selected: Set<string>;
  pendingKeys: Set<string>;
  onToggle: (k: string) => void;
  onDismiss: (scanId: string, category: ProblemCategory) => void;
  onCancel: (k: string) => void;
}) {
  const [detail, setDetail] = useState<ShippingLossScan | null>(null);

  return (
    <>
      {/* Desktop: the full table. Mobile gets its own compact card list
          below instead of squeezing 8 columns into a phone width — see
          the card block's own comment. */}
      <div className="hidden md:block overflow-x-auto border border-line">
        {/* table-fixed + colgroup, not auto layout — caps the table at 100%
            of its container so it never forces a horizontal scroll no matter
            how long an order name or tracking number gets (see ScanTable.tsx's
            identical reasoning). Tracking wraps via break-all instead of
            truncating (never hide part of a tracking number); Order truncates
            since it's the one column with real unbounded-length content. */}
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-[4%]" />
            <col className="w-[22%]" />
            <col className="w-[26%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
            <col className="w-[4%]" />
          </colgroup>
          <thead className="bg-paper-dim text-ink-faint">
            <tr>
              <th className="px-3 py-2" />
              <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
              <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
              <th className="text-left px-3 py-2 tag-label !text-ink-faint">Paid</th>
              <th className="text-left px-3 py-2 tag-label !text-ink-faint">Charged</th>
              <th className="text-left px-3 py-2 tag-label !text-ink-faint">Loss</th>
              <th className="text-left px-3 py-2 tag-label !text-ink-faint">Shipment</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const k = rowKey("loss", i.id);
              const pending = pendingKeys.has(k);
              return (
                <tr key={i.id} className={`border-t border-line bg-paper-panel align-top ${pending ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(k)} onChange={() => onToggle(k)} aria-label={`Select ${i.trackingNumber}`} />
                  </td>
                  <td className="px-3 py-2 data break-all">
                    {i.trackingUrl ? (
                      <a href={i.trackingUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                        {i.trackingNumber}
                      </a>
                    ) : (
                      i.trackingNumber
                    )}
                  </td>
                  <td className="px-3 py-2 data truncate">{i.orderName ?? <span className="text-ink-faint">—</span>}</td>
                  <td className="px-3 py-2 data">{formatMoney(i.costAmount, i.costCurrency)}</td>
                  <td className="px-3 py-2 data">{formatMoney(i.chargedAmount, i.chargedCurrency)}</td>
                  <td className="px-3 py-2 data font-semibold !text-red-ink">-{formatMoney(i.lossAmount, i.costCurrency)}</td>
                  <td className="px-3 py-2 data">
                    <Link href={`/shipments/${i.sessionId}`} className="text-blue hover:underline">
                      {i.sessionId.slice(0, 8).toUpperCase()}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <DismissCell pending={pending} onDismiss={() => onDismiss(i.id, "loss")} onCancel={() => onCancel(k)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile card list — tracking number and the one headline figure
          (the loss amount, this section's whole reason for existing) up
          front; everything else (paid, charged, shipment link) sits behind
          the info icon's DetailModal instead of cramming 8 columns into a
          phone width. */}
      <div className="md:hidden flex flex-col gap-2">
        {items.map((i) => {
          const k = rowKey("loss", i.id);
          const pending = pendingKeys.has(k);
          return (
            <div key={i.id} className={`border border-line bg-paper-panel p-3 flex items-center gap-2 ${pending ? "opacity-50" : ""}`}>
              <input type="checkbox" checked={selected.has(k)} onChange={() => onToggle(k)} aria-label={`Select ${i.trackingNumber}`} />
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="data text-sm break-all">{i.trackingNumber}</span>
                <span className="text-xs text-ink-faint truncate">{i.orderName ?? "No order match"}</span>
              </div>
              <span className="data text-sm font-semibold !text-red-ink shrink-0">-{formatMoney(i.lossAmount, i.costCurrency)}</span>
              <button
                type="button"
                onClick={() => setDetail(i)}
                aria-label="View details"
                className="text-ink-faint hover:text-ink shrink-0"
              >
                <InfoIcon className="w-5 h-5" />
              </button>
              <DismissCell pending={pending} onDismiss={() => onDismiss(i.id, "loss")} onCancel={() => onCancel(k)} />
            </div>
          );
        })}
      </div>

      {detail && (
        <DetailModal title={detail.trackingNumber} onClose={() => setDetail(null)}>
          <DetailRow label="Order" value={detail.orderName ?? "—"} />
          <DetailRow label="Paid" value={formatMoney(detail.costAmount, detail.costCurrency)} />
          <DetailRow label="Charged" value={formatMoney(detail.chargedAmount, detail.chargedCurrency)} />
          <DetailRow label="Loss" value={<span className="!text-red-ink font-semibold">-{formatMoney(detail.lossAmount, detail.costCurrency)}</span>} />
          <DetailRow
            label="Shipment"
            value={
              <Link href={`/shipments/${detail.sessionId}`} className="text-blue hover:underline">
                {detail.sessionId.slice(0, 8).toUpperCase()}
              </Link>
            }
          />
          {detail.trackingUrl && (
            <DetailRow
              label="Track"
              value={
                <a href={detail.trackingUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline break-all">
                  {detail.trackingNumber}
                </a>
              }
            />
          )}
        </DetailModal>
      )}
    </>
  );
}

function CarrierTable({
  items,
  selected,
  pendingKeys,
  onToggle,
  onDismiss,
  onCancel,
}: {
  items: CarrierRow[];
  selected: Set<string>;
  pendingKeys: Set<string>;
  onToggle: (k: string) => void;
  onDismiss: (scanId: string, category: ProblemCategory) => void;
  onCancel: (k: string) => void;
}) {
  const status = useClickPopover<string>();
  const [detail, setDetail] = useState<CarrierRow | null>(null);

  return (
    <>
    <div className="hidden md:block overflow-x-auto border border-line">
      {/* table-fixed + colgroup — same reasoning as LossTable above: caps
          the table at 100% width so it never scrolls horizontally. Status
          gets the largest share so its `truncate` (below) only clips once
          it genuinely runs out of room, not from a starved column; Tracking
          wraps in full via break-all rather than ever truncating. */}
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-[4%]" />
          <col className="w-[20%]" />
          <col className="w-[18%]" />
          <col className="w-[38%]" />
          <col className="w-[10%]" />
          <col className="w-[6%]" />
          <col className="w-[4%]" />
        </colgroup>
        <thead className="bg-paper-dim text-ink-faint">
          <tr>
            <th className="px-3 py-2" />
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Status</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Shipment</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Age</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const k = rowKey(i.category, i.id);
            const pending = pendingKeys.has(k);
            return (
              <tr key={k} className={`border-t border-line bg-paper-panel align-top ${pending ? "opacity-50" : ""}`}>
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(k)} onChange={() => onToggle(k)} aria-label={`Select ${i.trackingNumber}`} />
                </td>
                <td className="px-3 py-2 data break-all">
                  {i.trackingUrl ? (
                    <a href={i.trackingUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                      {i.trackingNumber}
                    </a>
                  ) : (
                    i.trackingNumber
                  )}
                </td>
                <td className="px-3 py-2 data truncate">{i.orderName ?? <span className="text-ink-faint">—</span>}</td>
                <td className="px-3 py-2">
                  {i.statusLabel ? (
                    <span
                      className="relative inline-block max-w-full"
                      ref={status.openId === k ? (status.ref as React.RefObject<HTMLSpanElement>) : undefined}
                    >
                      <button
                        type="button"
                        onClick={() => status.setOpenId((id) => (id === k ? null : k))}
                        className={`tag-label !text-[0.65rem] px-1.5 py-0.5 inline-block max-w-full truncate align-bottom ${statusTone(i.statusLabel)}`}
                      >
                        {i.statusLabel}
                      </button>
                      {/* Click, not hover, to reveal the full text. */}
                      {status.openId === k && (
                        <span className="absolute left-0 top-full mt-1 z-20 max-w-xs whitespace-normal bg-ink text-paper text-xs px-2 py-1 shadow">
                          {i.statusLabel}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-ink-faint">no status yet</span>
                  )}
                </td>
                <td className="px-3 py-2 data whitespace-nowrap">
                  <Link href={`/shipments/${i.sessionId}`} className="text-blue hover:underline">
                    {i.sessionId.slice(0, 8).toUpperCase()}
                  </Link>
                </td>
                <td className="px-3 py-2 text-ink-faint whitespace-nowrap" title={i.statusAt ? formatCarrierTimestamp(i.statusAt) : undefined}>
                  {i.daysSinceUpdate}d
                </td>
                <td className="px-3 py-2">
                  <DismissCell pending={pending} onDismiss={() => onDismiss(i.id, i.category)} onCancel={() => onCancel(k)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile card list — tracking number and status badge up front (the
        two things worth a glance); order, shipment link, and age sit
        behind the info icon's DetailModal instead of a 7-column table
        squeezed into a phone width. */}
    <div className="md:hidden flex flex-col gap-2">
      {items.map((i) => {
        const k = rowKey(i.category, i.id);
        const pending = pendingKeys.has(k);
        return (
          <div key={k} className={`border border-line bg-paper-panel p-3 flex items-center gap-2 ${pending ? "opacity-50" : ""}`}>
            <input type="checkbox" checked={selected.has(k)} onChange={() => onToggle(k)} aria-label={`Select ${i.trackingNumber}`} />
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="data text-sm break-all">{i.trackingNumber}</span>
              <span className="text-xs text-ink-faint truncate">{i.orderName ?? "No order match"}</span>
            </div>
            {i.statusLabel ? (
              <span className={`tag-label !text-[0.6rem] px-1.5 py-0.5 shrink-0 max-w-[9rem] truncate ${statusTone(i.statusLabel)}`}>
                {i.statusLabel}
              </span>
            ) : (
              <span className="text-ink-faint text-xs shrink-0">no status</span>
            )}
            <button
              type="button"
              onClick={() => setDetail(i)}
              aria-label="View details"
              className="text-ink-faint hover:text-ink shrink-0"
            >
              <InfoIcon className="w-5 h-5" />
            </button>
            <DismissCell pending={pending} onDismiss={() => onDismiss(i.id, i.category)} onCancel={() => onCancel(k)} />
          </div>
        );
      })}
    </div>

    {detail && (
      <DetailModal title={detail.trackingNumber} onClose={() => setDetail(null)}>
        <DetailRow label="Order" value={detail.orderName ?? "—"} />
        <DetailRow label="Status" value={detail.statusLabel ?? "No status yet"} />
        <DetailRow label="Age" value={`${detail.daysSinceUpdate}d${detail.statusAt ? ` · ${formatCarrierTimestamp(detail.statusAt)}` : ""}`} />
        <DetailRow
          label="Shipment"
          value={
            <Link href={`/shipments/${detail.sessionId}`} className="text-blue hover:underline">
              {detail.sessionId.slice(0, 8).toUpperCase()}
            </Link>
          }
        />
        {detail.trackingUrl && (
          <DetailRow
            label="Track"
            value={
              <a href={detail.trackingUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline break-all">
                {detail.trackingNumber}
              </a>
            }
          />
        )}
      </DetailModal>
    )}
    </>
  );
}
