# Ship Logger

A warehouse scan station for outbound shipments across three carriers — ePost Global (EPG), UPS, and DHL — built for OTC Shoppe Express. Plan in [`docs/PRD.md`](docs/PRD.md).

Packers sign in with a 4-digit PIN, scan tracking numbers, and the app auto-detects the carrier, groups ePost Global parcels into numbered boxes for consolidated shipping, and blocks a number that's already shipped in a prior submitted shipment. Every submitted day's shipment is searchable by tracking number afterward, and any scanned tracking number resolves to its Shopify order — line items, ship-to — without opening Shopify.

Live at [ship-logger.vercel.app](https://ship-logger.vercel.app).

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind CSS 4
- Postgres via Drizzle ORM (`lib/db/`) — Supabase in production, any Postgres works locally
- `postgres.js` as the driver, configured for Supabase's transaction pooler (`prepare: false`) since Vercel's serverless functions are short-lived
- `ts-tracking-number` for UPS/DHL check-digit validation
- Shopify Admin API (`lib/shopify.ts`), authenticated via OAuth client-credentials grant — no interactive install flow, just `client_id` + `client_secret` traded for a short-lived (~24h) access token

## Getting started

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL and SESSION_SECRET at minimum
npm run db:migrate
npm run db:seed              # creates an admin user, PIN printed to console
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run db:generate` | Generate a new Drizzle migration after a schema change |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed an admin user (PIN from `SEED_ADMIN_PIN`, default `1234`) |
| `npm run shopify:register-webhook` | Register the fulfillment webhooks against a callback URL (`CALLBACK_URL=... npm run shopify:register-webhook`) — run once per deployment domain |
| `npm run shopify:backfill-orders` | One-time backfill of the order index from existing Shopify order history (`--days N`, default 180) |
| `npx tsx scripts/import-fruugo-order.ts <file.json> [--dry-run]` | Creates a Shopify order from a Fruugo order transcribed into JSON (Fruugo has no order API). Line items are matched by **product title**, not SKU — Fruugo's SKUs don't correspond to anything in this catalog. Always run with `--dry-run` first. See `scripts/fruugo-order.example.json` for the file shape. Needs `read_products` + `write_orders` scopes in addition to this app's existing read scopes. |
| `npx tsx scripts/import-fruugo-order.ts <file.json>` (no `--dry-run`) | Actually creates the order. Requires a one-time OAuth install first — see below. |
| `npx tsx scripts/search-product.ts "search terms"` | Finds a variant's real SKU by product title — for when a Fruugo order's SKU doesn't match what's in Shopify. |
| `npm run lint` | ESLint |

## Environment variables

See [`.env.example`](.env.example).

- `DATABASE_URL` — Postgres connection string. In production, use Supabase's **transaction pooler** URI (port 6543), not the direct connection — Vercel's serverless functions each get their own short-lived connection, and the direct connection limit exhausts fast under concurrent invocations.
- `SESSION_SECRET` — signs the session cookie. Falls back to an insecure dev-only value if unset; **never deploy without setting it**.
- `CRON_SECRET` — optional, protects `/api/cron/epg-status` from being triggered by anyone who finds the URL. Vercel Cron sends this automatically when set (see `vercel.json`).
- `SHOPIFY_STORE`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` — the custom app credential used for order lookups. The app needs `read_orders`, `read_all_orders`, `read_fulfillments`, and `read_customers` scopes approved on the store, plus protected customer data access configured in the Dev Dashboard (see PRD §9, Step 0) — without these, `orders`/`order` queries (or just the `customer` field on them) fail with `ACCESS_DENIED`.
- `SHOPIFY_APP_URL` — this app's own deployed URL, no trailing slash (e.g. `https://ship-logger.vercel.app`). Only needed to actually create Fruugo orders (not for order lookups) — see below.

## Creating orders via the API (one-time setup)

`import-fruugo-order.ts`'s `createOrder` calls Shopify's `orderCreate` mutation, which Shopify restricts to apps authenticated with a genuine **offline** access token — the client-credentials token above (short-lived, re-minted automatically) is rejected outright regardless of scopes, with `Access denied for orderCreate field... This mutation is only accessible to apps authenticated using offline access tokens`.

To mint one:

1. Add `https://<your-app-url>/api/auth/callback` to this app's allowed redirect URLs in the Shopify Partner/Dev Dashboard (same place the existing scopes got approved — see PRD §9, Step 0).
2. Set `SHOPIFY_APP_URL` in the deployment's environment.
3. Log into Ship Logger as an admin, then visit `/api/auth/install` in the same browser (also logged into Shopify Admin for the store). It redirects to Shopify's OAuth consent screen; approving it stores an offline token in the `shopify_offline_token` table.
4. Order creation now works. The token doesn't expire, so this is a one-time step per deployment — only redo it if the app is ever uninstalled from the store.

## Notes for future work

- `lib/epg.ts` talks to an **undocumented, unofficial** ePost Global endpoint (verified working, not supported by EPG) — see the comment at the top of that file before changing it.
- `lib/shopify.ts` intentionally has no `import "server-only"` — it's also imported by the standalone scripts above, run via bare `tsx` outside Next.js's bundler, where that guard throws unpredictably rather than being enforced correctly.
- Timestamp columns are `text`, not Postgres's native `timestamp` type, formatted as `"YYYY-MM-DD HH:MI:SS"` UTC with no zone marker (see the comment in `lib/db/schema.ts` and the helpers in `lib/date.ts`). This is a deliberate holdover from the original SQLite dev setup, not an oversight — changing it means touching every display site that reads a scan/session timestamp.
- Row Level Security is enabled on all tables with no policies, since the app only ever connects via `DATABASE_URL` directly and never through Supabase's PostgREST/anon-key surface.
- The Shopify webhook subscriptions (`FULFILLMENTS_CREATE`/`FULFILLMENTS_UPDATE`) are registered directly via the Admin API (`scripts/register-webhook.ts`), not through `shopify.app.toml` — the app credential this project uses was never deployed as its own web app, so there's no real `application_url` for the TOML's declarative webhook config to point at. Re-run the script with a new `CALLBACK_URL` if the deployment domain ever changes.
