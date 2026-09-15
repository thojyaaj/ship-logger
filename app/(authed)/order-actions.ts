"use server";

import { requireUser } from "@/lib/auth";
import { getOrderDetail, type OrderDetail } from "@/lib/shopify";
import { orderIsReferencedLocally } from "@/lib/order-index";

export type OrderDetailResult = { status: "ok"; order: OrderDetail | null } | { status: "error"; message: string };

/** §9c click-through — live Shopify query, fine for an on-demand click. */
export async function getOrderDetailAction(orderGid: string): Promise<OrderDetailResult> {
  await requireUser();
  if (!(await orderIsReferencedLocally(orderGid))) {
    return { status: "error", message: "This order is not referenced by a local shipment." };
  }
  return { status: "ok", order: await getOrderDetail(orderGid) };
}
