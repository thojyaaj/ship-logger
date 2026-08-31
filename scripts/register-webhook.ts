/**
 * One-time (well, "run whenever the callback URL changes") registration of
 * the FULFILLMENTS_CREATE/UPDATE webhook subscriptions for §9b.
 *
 * Not declared in shopify.app.toml: that app (OTC Shoppe Express) exists
 * solely as Ship Logger's API credential and was never deployed as a web
 * app in its own right, so `shopify app deploy` has nowhere real to point
 * `application_url` at. Registering directly via the Admin API instead
 * lets the callback point at Ship Logger's actual deployed URL.
 *
 * Usage: SHOPIFY_STORE=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... \
 *        CALLBACK_URL=https://ship-logger.vercel.app/api/webhooks/shopify \
 *        npx tsx scripts/register-webhook.ts
 */
process.loadEnvFile?.(".env.local");

import { shopifyGraphql } from "../lib/shopify";

const CALLBACK_URL = process.env.CALLBACK_URL;
if (!CALLBACK_URL) {
  console.error("Set CALLBACK_URL to the deployed webhook endpoint, e.g.");
  console.error("  https://ship-logger.vercel.app/api/webhooks/shopify");
  process.exit(1);
}

const MUTATION = `
  mutation($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

async function subscribe(topic: "FULFILLMENTS_CREATE" | "FULFILLMENTS_UPDATE") {
  const data = await shopifyGraphql<{
    webhookSubscriptionCreate: {
      webhookSubscription: { id: string; topic: string } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(MUTATION, { topic, callbackUrl: CALLBACK_URL });

  const { webhookSubscription, userErrors } = data.webhookSubscriptionCreate;
  if (userErrors.length > 0) {
    console.error(`${topic}: `, userErrors);
    return;
  }
  console.log(`${topic}: subscribed (${webhookSubscription?.id})`);
}

async function main() {
  await subscribe("FULFILLMENTS_CREATE");
  await subscribe("FULFILLMENTS_UPDATE");
  process.exit(0);
}

main();
