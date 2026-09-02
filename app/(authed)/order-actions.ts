"use server";

import { requireUser } from "@/lib/auth";
import { getOrderDetail, type OrderDetail } from "@/lib/shopify";
import { orderIsReferencedLocally } from "@/lib/order-index";

/** §9c click-through — live Shopify query, fine for an on-demand click. */
export async function getOrderDetailAction(orderGid: string): Promise<OrderDetail | null> {
  await requireUser();
  if (!(await orderIsReferencedLocally(orderGid))) {
    throw new Error("This order is not referenced by a local shipment.");
  }
  return getOrderDetail(orderGid);
}
