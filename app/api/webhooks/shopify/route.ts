import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getOrderSummary } from "@/lib/shopify";
import { upsertOrderIndex } from "@/lib/order-index";

/**
 * §9b — receives FULFILLMENTS_CREATE and FULFILLMENTS_UPDATE. Both topics
 * deliver the same REST-shaped Fulfillment resource (order_id,
 * tracking_numbers, ...) with no order/customer/address details, so this
 * makes one follow-up GraphQL call per event to fill those in.
 *
 * No idempotency table for X-Shopify-Webhook-Id: the only effect of a
 * redelivery is upsertOrderIndex re-writing the same latest-known values,
 * which is safe to repeat by construction (no counters, no appends).
 *
 * The subscription itself isn't declared in shopify.app.toml — this app
 * (OTC Shoppe Express) exists solely as Ship Logger's API credential and
 * was never deployed as its own web app, so the webhook is registered
 * directly against this URL via a one-time script instead. See
 * scripts/register-webhook.ts.
 */

type FulfillmentWebhookPayload = {
  order_id: number;
  tracking_numbers?: string[];
  tracking_number?: string | null;
};

function verifyHmac(rawBody: string, hmacHeader: string | null): boolean {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");

  if (!verifyHmac(rawBody, hmacHeader)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  // Defence in depth behind the HMAC: this app serves exactly one store, so a
  // correctly-signed delivery for any other shop domain is not something we
  // should index. Cheap, and it means a future multi-store credential mix-up
  // can't quietly write another store's fulfilments into this order index.
  const shopDomain = req.headers.get("x-shopify-shop-domain");
  const expectedShop = process.env.SHOPIFY_STORE;
  if (expectedShop && shopDomain && shopDomain !== expectedShop) {
    return new NextResponse("Unexpected shop domain", { status: 401 });
  }

  let payload: FulfillmentWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const trackingNumbers = (
    payload.tracking_numbers?.length ? payload.tracking_numbers : [payload.tracking_number]
  ).filter((n): n is string => !!n);

  if (trackingNumbers.length === 0 || !payload.order_id) {
    // No tracking yet (e.g. a fulfillment created before a label exists) —
    // nothing to index. Not an error; Shopify will send FULFILLMENTS_UPDATE
    // once tracking is attached.
    return NextResponse.json({ ok: true, skipped: "no tracking number" });
  }

  try {
    const order = await getOrderSummary(payload.order_id);
    if (!order) {
      return NextResponse.json({ ok: true, skipped: "order not found" });
    }
    await upsertOrderIndex(trackingNumbers, order);
    return NextResponse.json({ ok: true, indexed: trackingNumbers.length });
  } catch (err) {
    console.error("[webhooks/shopify] fulfillment indexing failed:", err);
    // A retry is exactly what we want for a transient Shopify/database outage.
    return NextResponse.json({ ok: false, error: "Fulfillment indexing failed." }, { status: 503 });
  }
}
