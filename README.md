# Ship Logger

A warehouse scan station for outbound shipments across three carriers — ePost Global (EPG), UPS, and DHL — built for OTC Shoppe Express. Phase 1 of the plan in [`docs/PRD.md`](docs/PRD.md).

Packers sign in with a 4-digit PIN, scan tracking numbers, and the app auto-detects the carrier, groups ePost Global parcels into numbered boxes for consolidated shipping, and blocks a number that's already shipped in a prior submitted shipment. Every submitted day's shipment is searchable by tracking number afterward.

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind CSS 4
- SQLite via Drizzle ORM (`lib/db/`) — schema is written to be easy to port to Postgres later
- `ts-tracking-number` for UPS/DHL check-digit validation
- No Shopify dependency in Phase 1 by design — see the PRD for why

## Getting started

```bash
npm install
cp .env.example .env.local   # set SESSION_SECRET at minimum
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
| `npm run lint` | ESLint |

## Environment variables

See [`.env.example`](.env.example). `SESSION_SECRET` is the only one that matters for a real deployment — everything else has a workable default for local development.

## Notes for future work

- `lib/epg.ts` talks to an **undocumented, unofficial** ePost Global endpoint (verified working, not supported by EPG) — see the comment at the top of that file before changing it.
- `app/api/cron/epg-status/route.ts` is meant to run on a schedule (`vercel.json` has the cron config); protect it with `CRON_SECRET` in production.
- Session cookies fall back to an insecure dev secret if `SESSION_SECRET` is unset — never deploy without setting it.
