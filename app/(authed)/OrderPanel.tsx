"use client";

import { useEffect, useState } from "react";
import type { OrderDetail } from "@/lib/shopify";
import { getOrderDetailAction } from "./order-actions";

/**
 * §9c click-through — "any tracking in history opens an order panel: order
 * #, date, customer, line items, ship-to, and a deep link into the Shopify
 * admin." Fetches live on open rather than caching, since this is an
 * on-demand click, not scan-time enrichment.
 */
export default function OrderPanel({ orderGid, onClose }: { orderGid: string; onClose: () => void }) {
  const [order, setOrder] = useState<OrderDetail | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getOrderDetailAction(orderGid).then((result) => {
      if (!cancelled) setOrder(result);
    });
    return () => {
      cancelled = true;
    };
  }, [orderGid]);

  return (
    <div className="fixed inset-0 bg-ink/60 flex items-center justify-center p-4 z-30">
      <div className="corners bg-paper-panel p-6 max-w-md w-full flex flex-col gap-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between route-line pb-3">
          <h2 className="font-stencil text-xl tracking-wide">
            {order === undefined ? "Loading…" : (order?.name ?? "Not found")}
          </h2>
          <button onClick={onClose} className="tag-label hover:!text-ink">
            ✕ Close
          </button>
        </div>

        {order === undefined && <p className="text-ink-faint text-sm data">FETCHING ORDER…</p>}

        {order === null && (
          <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">
            No matching order found in Shopify — check the tracking number was scanned correctly.
          </p>
        )}

        {order && (
          <>
            <dl className="flex flex-col gap-2 text-sm">
              <Field label="Order date" value={new Date(order.createdAt).toLocaleString()} />
              <Field label="Customer" value={order.customerName ?? "—"} />
              <Field label="Ship to" value={order.shippingAddress ?? "—"} />
            </dl>

            <div>
              <span className="tag-label">Line items</span>
              <ul className="mt-1 flex flex-col gap-1">
                {order.lineItems.map((item, i) => (
                  <li key={i} className="flex justify-between text-sm font-condensed">
                    <span>{item.title}</span>
                    <span className="data text-ink-soft">×{item.quantity}</span>
                  </li>
                ))}
              </ul>
            </div>

            <a
              href={order.adminUrl}
              target="_blank"
              rel="noreferrer"
              className="btn text-center py-3 bg-orange text-paper"
            >
              Open in Shopify admin →
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tag-label">{label}</div>
      <div className="font-condensed">{value}</div>
    </div>
  );
}
