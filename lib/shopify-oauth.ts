// Standard OAuth Authorization Code install flow, used exactly once (per
// deploy domain) to mint a genuine Shopify "offline" access token — see
// lib/shopify.ts's file-level comment for why the client-credentials token
// used everywhere else can't do this: Shopify's orderCreate mutation
// rejects it outright ("This mutation is only accessible to apps
// authenticated using offline access tokens"), no matter what scopes are
// granted. This file exists only to get that one token; every other Admin
// API call in this app still goes through lib/shopify.ts as before.
import crypto from "node:crypto";
import { db } from "./db";
import { shopifyOfflineToken } from "./db/schema";
import { eq } from "drizzle-orm";

// Mirrors the scopes already approved for this app's client-credentials
// token (see README's Environment variables section) so the offline token
// can do everything this app needs without a second Partner Dashboard
// approval round trip.
const OAUTH_SCOPES = "read_orders,read_all_orders,read_fulfillments,read_customers,read_products,write_orders";

function store(): string {
  const value = process.env.SHOPIFY_STORE;
  if (!value) throw new Error("SHOPIFY_STORE is not set.");
  return value;
}

function appUrl(): string {
  const value = process.env.SHOPIFY_APP_URL;
  if (!value) throw new Error("SHOPIFY_APP_URL is not set — see .env.example.");
  return value.replace(/\/+$/, "");
}

export function redirectUri(): string {
  return `${appUrl()}/api/auth/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) throw new Error("SHOPIFY_CLIENT_ID is not set.");
  const params = new URLSearchParams({
    client_id: clientId,
    scope: OAUTH_SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return `https://${store()}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Verifies an OAuth callback's `hmac` param per Shopify's documented method
 * for the *authorization code* flow: every query param except hmac/
 * signature, sorted by key, joined as `key=value` pairs with `&`, HMAC-SHA256
 * digested (hex — unlike the webhook handler's base64 digest in
 * app/api/webhooks/shopify/route.ts, which verifies a raw request body
 * instead of query params) with the client secret.
 */
export function verifyCallbackHmac(searchParams: URLSearchParams): boolean {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  const hmac = searchParams.get("hmac");
  if (!secret || !hmac) return false;

  const pairs: string[] = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const digest = crypto.createHmac("sha256", secret).update(pairs.join("&"), "utf8").digest("hex");

  const a = Buffer.from(digest);
  const b = Buffer.from(hmac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeCodeForOfflineToken(code: string): Promise<{ accessToken: string; scope: string }> {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set.");
  }

  const res = await fetch(`https://${store()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) {
    throw new Error(`Shopify offline token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; scope: string };
  return { accessToken: data.access_token, scope: data.scope };
}

export async function storeOfflineToken(accessToken: string, scope: string): Promise<void> {
  await db
    .insert(shopifyOfflineToken)
    .values({ shop: store(), accessToken, scope })
    .onConflictDoUpdate({
      target: shopifyOfflineToken.shop,
      set: { accessToken, scope },
    });
}

/**
 * Read by lib/shopify.ts's createOrder. Throws with the install URL rather
 * than a bare "not found" — the failure mode here is always "nobody has
 * completed the one-time install yet," and the fix is always the same link.
 */
export async function getOfflineAccessToken(): Promise<string> {
  const rows = await db
    .select()
    .from(shopifyOfflineToken)
    .where(eq(shopifyOfflineToken.shop, store()))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `No Shopify offline access token on file for ${store()}. ` +
        `Visit ${appUrl()}/api/auth/install as an admin to install the app and mint one.`,
    );
  }
  return row.accessToken;
}
