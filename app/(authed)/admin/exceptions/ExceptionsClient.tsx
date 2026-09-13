"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ProblemScan, ShippingLossScan, ProblemCategory } from "@/lib/shipment-alerts";
import { carrierLabel, statusTone, type Carrier } from "@/lib/carrier";
import { formatCarrierTimestamp } from "@/lib/date";
import { dismissProblemAction, dismissProblemsAction } from "./actions";

const CARRIER_ORDER: Carrier[] = ["ups", "dhl", "epg"];

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

/**
 * Client wrapper for /admin/exceptions — the server component
 * (page.tsx) just fetches and hands off; everything selection/dismiss
 * related lives here since it needs interaction state. router.refresh()
 * after a dismissal re-runs the server component with fresh data (same
 * pattern as SwipeableShipmentRow's delete, UsersClient, etc.) rather than
 * hand-rolling client-side list surgery.
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
  const [isPending, startTransition] = useTransition();

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

  function dismissOne(scanId: string, category: ProblemCategory) {
    startTransition(async () => {
      await dismissProblemAction(scanId, category);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(rowKey(category, scanId));
        return next;
      });
      router.refresh();
    });
  }

  function dismissSelected(keys: string[]) {
    const items = keys.map((k) => {
      const [category, scanId] = k.split(":") as [ProblemCategory, string];
      return { scanId, category };
    });
    startTransition(async () => {
      await dismissProblemsAction(items);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
      router.refresh();
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
        <span className="tag-label !text-ink-faint">{total} open</span>
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
              <LossTable items={losses} selected={selected} onToggle={toggle} onDismiss={dismissOne} isPending={isPending} />
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
                <CarrierTable items={rows} selected={selected} onToggle={toggle} onDismiss={dismissOne} isPending={isPending} />
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
            className="btn px-2.5 py-1 text-xs bg-orange text-paper disabled:opacity-50"
          >
            Dismiss selected ({selectedInSection.length})
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

function LossTable({
  items,
  selected,
  onToggle,
  onDismiss,
  isPending,
}: {
  items: ShippingLossScan[];
  selected: Set<string>;
  onToggle: (k: string) => void;
  onDismiss: (scanId: string, category: ProblemCategory) => void;
  isPending: boolean;
}) {
  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm table-fixed">
        <thead className="bg-paper-dim text-ink-faint">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Paid</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Charged</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Loss</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Shipment</th>
            <th className="w-20 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const k = rowKey("loss", i.id);
            return (
              <tr key={i.id} className="border-t border-line bg-paper-panel">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(k)} onChange={() => onToggle(k)} aria-label={`Select ${i.trackingNumber}`} />
                </td>
                <td className="px-3 py-2 data truncate">
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
                <td className="px-3 py-2 data truncate">
                  <Link href={`/shipments/${i.sessionId}`} className="text-blue hover:underline">
                    {i.sessionId.slice(0, 8).toUpperCase()}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => onDismiss(i.id, "loss")}
                    className="text-xs text-ink-faint hover:text-ink underline disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CarrierTable({
  items,
  selected,
  onToggle,
  onDismiss,
  isPending,
}: {
  items: CarrierRow[];
  selected: Set<string>;
  onToggle: (k: string) => void;
  onDismiss: (scanId: string, category: ProblemCategory) => void;
  isPending: boolean;
}) {
  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm table-fixed">
        <thead className="bg-paper-dim text-ink-faint">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Status</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Age</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Shipment</th>
            <th className="w-20 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const k = rowKey(i.category, i.id);
            return (
              <tr key={k} className="border-t border-line bg-paper-panel">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(k)} onChange={() => onToggle(k)} aria-label={`Select ${i.trackingNumber}`} />
                </td>
                <td className="px-3 py-2 data truncate">
                  {i.trackingUrl ? (
                    <a href={i.trackingUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                      {i.trackingNumber}
                    </a>
                  ) : (
                    i.trackingNumber
                  )}
                </td>
                <td className="px-3 py-2 data truncate">{i.orderName ?? <span className="text-ink-faint">—</span>}</td>
                <td className="px-3 py-2 truncate" title={i.statusLabel ?? undefined}>
                  {i.statusLabel ? (
                    <span
                      className={`tag-label !text-[0.65rem] px-1.5 py-0.5 inline-block max-w-full truncate ${statusTone(i.statusLabel)}`}
                    >
                      {i.statusLabel}
                    </span>
                  ) : (
                    <span className="text-ink-faint">no status yet</span>
                  )}
                </td>
                <td className="px-3 py-2 text-ink-faint" title={i.statusAt ? formatCarrierTimestamp(i.statusAt) : undefined}>
                  {i.daysSinceUpdate}d
                </td>
                <td className="px-3 py-2 data truncate">
                  <Link href={`/shipments/${i.sessionId}`} className="text-blue hover:underline">
                    {i.sessionId.slice(0, 8).toUpperCase()}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => onDismiss(i.id, i.category)}
                    className="text-xs text-ink-faint hover:text-ink underline disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
