"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { DismissedProblem } from "@/lib/shipment-alerts";
import { carrierLabel } from "@/lib/carrier";
import { formatDbTimestamp } from "@/lib/date";
import { undismissProblemAction } from "../actions";
import { RotateCcwIcon } from "../../../shipments/[id]/icons";

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

function categoryLabel(category: DismissedProblem["category"]): string {
  switch (category) {
    case "exception":
      return "Exception";
    case "stale":
      return "Stale";
    case "loss":
      return "Shipping loss";
  }
}

function detail(item: DismissedProblem): string {
  if (item.category === "loss") {
    return `Paid ${formatMoney(item.costAmount, item.costCurrency)}, charged ${formatMoney(item.chargedAmount, item.chargedCurrency)}`;
  }
  return item.statusLabel ?? "—";
}

/**
 * Every dismissal ever made — the durable undo for the exceptions page's
 * own 10s in-the-moment countdown. Restoring here is immediate, no
 * countdown of its own: this is already the deliberate "I want this back"
 * page, not a click that needs its own second-guessing buffer.
 */
export default function DismissedClient({ items }: { items: DismissedProblem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function restore(scanId: string, category: DismissedProblem["category"]) {
    startTransition(async () => {
      await undismissProblemAction(scanId, category);
      router.refresh();
    });
  }

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-2 route-line pb-2">
        <div className="flex items-center gap-3">
          <h1 className="font-stencil text-2xl tracking-wide">Dismissed History</h1>
          <Link href="/admin/exceptions" className="tag-label !text-ink-faint hover:!text-ink underline">
            ← Back to Exceptions
          </Link>
        </div>
        <span className="tag-label !text-ink-faint">{items.length} dismissed</span>
      </div>

      {items.length === 0 ? (
        <p className="text-ink-faint">Nothing has been dismissed yet.</p>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="w-full text-sm">
            <thead className="bg-paper-dim text-ink-faint">
              <tr>
                <th className="w-px whitespace-nowrap text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
                <th className="w-px whitespace-nowrap text-left px-3 py-2 tag-label !text-ink-faint">Carrier</th>
                <th className="w-px whitespace-nowrap text-left px-3 py-2 tag-label !text-ink-faint">Type</th>
                <th className="w-px whitespace-nowrap text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
                <th className="text-left px-3 py-2 tag-label !text-ink-faint">Detail</th>
                <th className="w-px whitespace-nowrap text-left px-3 py-2 tag-label !text-ink-faint">Dismissed</th>
                <th className="w-px whitespace-nowrap px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t border-line bg-paper-panel align-top">
                  <td className="px-3 py-2 data whitespace-nowrap">
                    {i.trackingUrl ? (
                      <a href={i.trackingUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                        {i.trackingNumber}
                      </a>
                    ) : (
                      i.trackingNumber
                    )}
                  </td>
                  <td className="px-3 py-2 data whitespace-nowrap">{carrierLabel(i.carrier)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{categoryLabel(i.category)}</td>
                  <td className="px-3 py-2 data whitespace-nowrap">{i.orderName ?? <span className="text-ink-faint">—</span>}</td>
                  <td className="px-3 py-2 whitespace-normal">{detail(i)}</td>
                  <td className="px-3 py-2 text-ink-faint whitespace-nowrap" title={formatDbTimestamp(i.dismissedAt)}>
                    {formatDbTimestamp(i.dismissedAt)}
                    <span className="block text-[0.65rem]">by {i.dismissedByName}</span>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => restore(i.scanId, i.category)}
                      title="Restore"
                      aria-label="Restore"
                      className="text-ink-faint hover:text-ink disabled:opacity-50"
                    >
                      <RotateCcwIcon className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
