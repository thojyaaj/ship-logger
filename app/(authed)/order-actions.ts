"use server";

import { requireUser } from "@/lib/auth";
import { getOrderDetail, type OrderDetail } from "@/lib/shopify";

/** §9c click-through — live Shopify query, fine for an on-demand click. */
export async function getOrderDetailAction(orderGid: string): Promise<OrderDetail | null> {
  await requireUser();
  return getOrderDetail(orderGid);
}
