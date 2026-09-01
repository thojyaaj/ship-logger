// No `import "server-only"` here deliberately: this module is also imported
// by standalone scripts (scripts/register-webhook.ts, backfill-orders.ts)
// run via bare `tsx`, outside Next.js's bundler — that's the only place
// "server-only"'s guard is actually enforced, so under plain tsx it just
// throws unpredictably. Every real runtime import of this file is already
// server-side only (a "use server" action, the EPG cron, or a script);
// OrderPanel.tsx's client-side import is `import type`, erased at compile
// time, so it never reaches the browser bundle regardless.

/**
 * Shopify Admin API client for a single-store custom app, authenticated via
 * the OAuth client-credentials grant (client_id + client_secret -> a
 * ~24h access token). Verified working 2026-08-31 against
 * otc-shoppe-express.myshopify.com — see PRD §9, Step 0 for the path that
 * got scopes approved (Dev Dashboard app version + store re-authorization).
 *
 * This is deliberately NOT a long-lived static token: client-credentials
 * tokens from Shopify expire in ~24h (observed expires_in: 86399), so the
 * client re-mints one on demand and caches it in memory until shortly
 * before expiry, same pattern as the UPS OAuth client credentials flow
 * documented in the PRD's carrier-API research.
 */

const API_VERSION = "2026-10";

// Matches the EPG and UPS clients, which both already set one. Without a
// timeout a single hung socket parks the caller indefinitely — and the EPG
// cron calls findOrderByName sequentially, once per pending scan, so one
// stalled connection would hold the whole run until the platform kills it.
const SHOPIFY_TIMEOUT_MS = 15_000;

function store(): string {
  const value = process.env.SHOPIFY_STORE;
  if (!value) throw new Error("SHOPIFY_STORE is not set.");
  return value;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set.");
  }

  const res = await fetch(`https://${store()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };

  // Refresh 5 minutes early so a long-running request never straddles expiry.
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };
  return cachedToken.token;
}

export type ShopifyGraphqlResult<T> = { data?: T; errors?: { message: string }[] };

export async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://${store()}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status}`);
  }
  const json = (await res.json()) as ShopifyGraphqlResult<T>;
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Shopify GraphQL response had no data.");
  return json.data;
}

export type ResolvedOrder = { gid: string; name: string };

/**
 * §9a — resolves an EPG parcel's order via its `ERef` (the Shopify order
 * name EPG echoes back, e.g. "OSE83480X26"). `name` is a documented,
 * supported orders() filter, so this needs no webhook index.
 */
export async function findOrderByName(name: string): Promise<ResolvedOrder | null> {
  // `name` is EPG's ERef — a value from a third party, echoed off a printed
  // label. It goes into Shopify's *search DSL*, not the GraphQL document (the
  // document uses a $query variable, so the query structure is never at risk),
  // but the DSL has its own operators: an ERef of `x OR financial_status:paid`
  // would change which order `orders(first: 1)` returns and link a scan to an
  // attacker-chosen order. Quoting the term makes Shopify treat it as a single
  // literal phrase; the backslash-escape keeps a quote in the value from
  // closing that phrase early.
  const quoted = `"${name.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
  const data = await shopifyGraphql<{
    orders: { edges: { node: { id: string; name: string } }[] };
  }>(
    `query($query: String!) {
      orders(first: 1, query: $query) {
        edges { node { id name } }
      }
    }`,
    { query: `name:${quoted}` },
  );
  const node = data.orders.edges[0]?.node;
  if (!node) return null;

  // Confirm the hit is the order we asked for rather than trusting Shopify's
  // first-result ordering — the point being that a crafted ERef can't steer a
  // scan onto some other order.
  //
  // Compared on a normalized form, NOT raw equality. Raw equality is stricter
  // than the old unverified behaviour, so it can only ever lose matches, and
  // ERef comes off a printed label: a difference in case, padding, or the
  // leading "#" Shopify displays would silently drop a perfectly good match.
  // Normalizing keeps the safety property (it's still the same order name)
  // without failing on cosmetics.
  return orderNameKey(node.name) === orderNameKey(name)
    ? { gid: node.id, name: node.name }
    : null;
}

function orderNameKey(value: string): string {
  return value.trim().replace(/^#/, "").replace(/\s+/g, "").toUpperCase();
}

export type OrderDetail = {
  gid: string;
  name: string;
  createdAt: string;
  customerName: string | null;
  shippingAddress: string | null;
  lineItems: { title: string; quantity: number }[];
  adminUrl: string;
};

/**
 * §9c click-through — full order detail for the order panel. Live query,
 * fine for an on-demand click.
 *
 * customerName is always null: the `customer` field requires a separate
 * `read_customers` scope (discovered live — "Access denied for customer
 * field") that wasn't part of §9's Step 0 request and isn't worth another
 * scope-approval round trip for a nice-to-have. shippingAddress is on the
 * Order type itself, not Customer, so it isn't gated the same way.
 */
export async function getOrderDetail(orderGid: string): Promise<OrderDetail | null> {
  const data = await shopifyGraphql<{
    order: {
      id: string;
      name: string;
      createdAt: string;
      shippingAddress: { formatted: string[] } | null;
      lineItems: { edges: { node: { title: string; quantity: number } }[] };
    } | null;
  }>(
    `query($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        shippingAddress { formatted }
        lineItems(first: 25) {
          edges { node { title quantity } }
        }
      }
    }`,
    { id: orderGid },
  );
  if (!data.order) return null;
  const numericId = data.order.id.split("/").pop();
  return {
    gid: data.order.id,
    name: data.order.name,
    createdAt: data.order.createdAt,
    customerName: null,
    shippingAddress: data.order.shippingAddress?.formatted.join(", ") ?? null,
    lineItems: data.order.lineItems.edges.map((e) => e.node),
    adminUrl: `https://${store()}/admin/orders/${numericId}`,
  };
}

export type OrderSummary = {
  gid: string;
  name: string;
  customerName: string | null;
  destination: string | null;
};

/**
 * §9b — REST-style fulfillment webhooks (`fulfillments/create`/`update`)
 * only carry the fulfillment itself (id, order_id, tracking_numbers, ...),
 * not order/customer/address details, so the webhook handler and the
 * backfill script both call this to fill in the rest with one follow-up
 * GraphQL lookup by order ID.
 */
export async function getOrderSummary(orderId: string | number): Promise<OrderSummary | null> {
  const gid = String(orderId).startsWith("gid://")
    ? String(orderId)
    : `gid://shopify/Order/${orderId}`;
  const data = await shopifyGraphql<{
    order: {
      id: string;
      name: string;
      shippingAddress: { formatted: string[] } | null;
    } | null;
  }>(
    `query($id: ID!) {
      order(id: $id) {
        id
        name
        shippingAddress { formatted }
      }
    }`,
    { id: gid },
  );
  if (!data.order) return null;
  return {
    gid: data.order.id,
    name: data.order.name,
    // customerName always null — see getOrderDetail's comment (needs read_customers).
    customerName: null,
    destination: data.order.shippingAddress?.formatted.join(", ") ?? null,
  };
}
