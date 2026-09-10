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
 * `customer` needs the `read_customers` scope plus protected-customer-data
 * access on top of the base scopes this app otherwise runs on — a narrower
 * grant than the rest of an order query needs, and one that in practice has
 * flipped between granted and denied independently of the rest (see the Dev
 * Dashboard gap noted in PRD §9, Step 0). shopifyGraphql throws on *any*
 * top-level GraphQL error, discarding whatever data did resolve — so denying
 * just this one field previously took an entire order lookup down with it,
 * including id/name/shippingAddress/lineItems, which need nothing beyond the
 * scopes already confirmed working. Detected by message text rather than a
 * structured error code since ShopifyGraphqlResult only types `.message`;
 * scoped specifically to "customer field" so a real outage (bad token,
 * network failure, a different missing scope) still propagates instead of
 * silently degrading.
 */
function isCustomerFieldAccessDenied(err: unknown): boolean {
  return err instanceof Error && /access denied for customer field/i.test(err.message);
}

/**
 * The retry below is silent by design (that's the whole point — a scope gap
 * shouldn't cost an error), but that means nothing distinguishes "the grant
 * is fine" from "still denied, quietly degrading every single call" once
 * this ships. One line per fallback, not a full trace — this can fire on
 * every order lookup while the scope stays denied, so it's a low-noise
 * `warn` (won't cluster in get_runtime_errors the way the old 503s did) meant
 * to be grepped for, not triaged as a new failure each time.
 */
function warnCustomerFieldFallback(context: string): void {
  console.warn(
    `[shopify] customer field access denied — degrading (${context}). ` +
      "Check read_customers / protected customer data access in the Partner Dashboard.",
  );
}

/**
 * §9c click-through — full order detail for the order panel. Live query,
 * fine for an on-demand click.
 *
 * `displayName` is used over first/last name directly since it's Shopify's
 * own null-safe computed field (falls back to email, then "Customer", rather
 * than rendering blank/undefined for a guest checkout with no name on file).
 * `customer` itself can still be null even when the field resolves — a
 * deleted customer, or an order placed without an account.
 */
export async function getOrderDetail(orderGid: string): Promise<OrderDetail | null> {
  type OrderFields = {
    id: string;
    name: string;
    createdAt: string;
    customer: { displayName: string } | null;
    shippingAddress: { formatted: string[] } | null;
    lineItems: { edges: { node: { title: string; quantity: number } }[] };
  };

  let order: OrderFields | null;
  try {
    const data = await shopifyGraphql<{ order: OrderFields | null }>(
      `query($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          customer { displayName }
          shippingAddress { formatted }
          lineItems(first: 25) {
            edges { node { title quantity } }
          }
        }
      }`,
      { id: orderGid },
    );
    order = data.order;
  } catch (err) {
    if (!isCustomerFieldAccessDenied(err)) throw err;
    warnCustomerFieldFallback(`getOrderDetail ${orderGid}`);
    // See isCustomerFieldAccessDenied — retry without the one field the
    // current grant doesn't cover, rather than showing the packer "Not
    // found" for an order that's actually right there.
    const data = await shopifyGraphql<{ order: Omit<OrderFields, "customer"> | null }>(
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
    order = data.order ? { ...data.order, customer: null } : null;
  }

  if (!order) return null;
  const numericId = order.id.split("/").pop();
  return {
    gid: order.id,
    name: order.name,
    createdAt: order.createdAt,
    customerName: order.customer?.displayName ?? null,
    shippingAddress: order.shippingAddress?.formatted.join(", ") ?? null,
    lineItems: order.lineItems.edges.map((e) => e.node),
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

  type OrderFields = {
    id: string;
    name: string;
    customer: { displayName: string } | null;
    shippingAddress: { formatted: string[] } | null;
  };

  let order: OrderFields | null;
  try {
    const data = await shopifyGraphql<{ order: OrderFields | null }>(
      `query($id: ID!) {
        order(id: $id) {
          id
          name
          customer { displayName }
          shippingAddress { formatted }
        }
      }`,
      { id: gid },
    );
    order = data.order;
  } catch (err) {
    if (!isCustomerFieldAccessDenied(err)) throw err;
    warnCustomerFieldFallback(`getOrderSummary ${gid}`);
    // See isCustomerFieldAccessDenied — gid/name/destination are what §9c's
    // scan-time enrichment and the order index actually depend on; customer
    // name is a nice-to-have on the order panel. A scope gap on one display
    // field shouldn't blank the whole index the way it did until this fix
    // (every fulfillment webhook delivery 503'd, silently, for hours).
    const data = await shopifyGraphql<{ order: Omit<OrderFields, "customer"> | null }>(
      `query($id: ID!) {
        order(id: $id) {
          id
          name
          shippingAddress { formatted }
        }
      }`,
      { id: gid },
    );
    order = data.order ? { ...data.order, customer: null } : null;
  }

  if (!order) return null;
  return {
    gid: order.id,
    name: order.name,
    customerName: order.customer?.displayName ?? null,
    destination: order.shippingAddress?.formatted.join(", ") ?? null,
  };
}
