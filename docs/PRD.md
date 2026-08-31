# Ship Log — PRD (v0.3, for review)

**Status:** Draft for review — nothing built yet.
**Date:** 2026-08-30
**Changelog v0.1 → v0.2:** AWB confirmed one-per-shipment (Q1) and never spanning
days (Q1a); UPS confirmed as a multi-piece shipment with one master tracking (§7,
§8.7); PIN-based user identification added (§8.1); duplicate-scan rule specified
(§8.4); live session dashboard promoted to a first-class feature (§8.6);
**free ePost Global status tracking found and verified (§5.6) — Phase 3 now costs $0
and moves into Phase 1.**
**Changelog v0.2 → v0.3:** EPG's `ERef` confirmed as the Shopify order name (Q7),
which yields a **fully supported Shopify lookup path for EPG parcels with no webhook
index** (§5.7) and splits Phase 2 into 9a (EPG, ~2 days) / 9b (UPS+DHL, ~3 days).
EPG labels confirmed printed in-house (Q9), raising Q10 and Q11.
**Owner:** thojyaaj
**Context:** OTC Shoppe Express (`otc-shoppe-express.myshopify.com`), warehouse outbound desk.

---

## 1. Problem

Every shipping day the team scans a pile of outbound labels across three carriers.
Today there is no record of *what went out, on what day, in which box, under which
master airbill*. When a customer or carrier disputes a shipment weeks later, research
means digging through Shopify one order at a time with no way to go the other
direction — from a tracking number back to an order.

Three carriers, two very different workflows:

| Carrier | Prefix / shape | Workflow |
|---|---|---|
| **ePost Global** | `EPG` + 15 digits (e.g. `EPG030976227097798`) | **Consolidated.** Many parcels go into one or more 20×20×20 master boxes, each box gets a UPS label to the EPG hub, and the shipment carries an AWB. We need to know which parcel was in which box. |
| **UPS** | `1Z` + 16 chars | One parcel, one label, ships direct. Only need "it went out today." |
| **DHL** | 10 digits | Same as UPS. |

## 2. Goals

1. A scan session that takes zero setup — land on the page, start scanning.
2. Auto-assign each scanned tracking number to the right carrier, no dropdowns.
3. For ePost Global, group scans into numbered boxes and capture the AWB + master
   UPS tracking on submit.
4. Persist each day's shipment as a searchable record.
5. Given a tracking number, get the Shopify order behind it in one click.
6. See the latest carrier status for any tracking we've recorded.

## 3. Non-goals (explicitly, for now)

- Buying/printing labels. We're recording what already exists.
- Inventory, picking, or packing verification against order contents.
- Customer-facing tracking pages or notification emails.
- Multi-warehouse, multi-store, or selling this to other merchants.

## 4. Users

- **Packer** (1–3 people, warehouse tablet or desktop + USB laser scanner): opens the
  page, scans, submits. Should never need to log into Shopify.
- **Researcher** (you, office/laptop): searches history, opens an order from a
  tracking number, checks status.

---

## 5. Research findings

This is the part that shapes the phasing. Three findings change the plan materially:
**§5.3 (Shopify can't search by tracking number)**, **§5.2 (ePost Global has no
self-serve API)**, and **§5.5 (there is nothing to fork)**.

### 5.1 Carrier detection from a tracking number — solved, use a library

- **[`jkeen/tracking_number_data`](https://github.com/jkeen/tracking_number_data)** is
  the canonical open dataset: JSON descriptions of how to detect, validate (including
  **check-digit algorithms**), and decode tracking numbers for UPS, DHL Express, FedEx,
  USPS, UPU S10, OnTrac, Amazon. Everything else is a port of it.
- **[`ts-tracking-number`](https://www.npmjs.com/package/ts-tracking-number)** (npm,
  TypeScript, actively maintained) is the best port — `getTracking()` /
  `findTracking()`, filterable by courier, returns carrier + tracking URL template.
  There's a Python port (`tracking-numbers`) if we ever go that way.
- Also seen: [`shipmethod`](https://github.com/cyberwombat/shipmethod) (no DHL),
  `tracking-url` (~11 years stale), `shipit`/`trackit` (scraping fallbacks).
  [`PackageTrackr`](https://github.com/DriftSolutions/PackageTrackr) (MIT) has a
  good pattern worth copying: check carriers in **priority order by pattern
  specificity**, so `^\d{10}$` never wins before a more specific rule.

**Known limitation:** detection is reliable for prefixed formats (UPS `1Z`, USPS `9400`,
S10) and ambiguous for bare numeric formats — DHL Express's 10-digit number is the
classic collision. In our case this doesn't bite: we only have three carriers and two
of them are prefixed, so the resolver is ~30 lines.

**Recommendation:** hand-write the three-carrier resolver (EPG prefix isn't in any
dataset — it's an EPG-internal format, not S10), but pull in `ts-tracking-number`
**for its check-digit validation** on UPS and DHL. A misread scan that silently
becomes a garbage row is the single most likely way this app produces bad data, and
checksum validation catches most of them at the moment of scan.

### 5.2 Status APIs — two are free and easy, ePost Global is the hard one

| Carrier | API | Auth | Cost | Limits / gotchas |
|---|---|---|---|---|
| **UPS** | [Track API](https://developer.ups.com/tag/OAuth-Client-Credentials) `onlinetools.ups.com/api/track/v1/details/{n}` | OAuth 2.0 client credentials | Free | **Not** account-scoped — you can track any number. No published rate limits. **Gotcha:** an unknown/unscanned number returns **HTTP 200** with `warnings[].code = TW0001`, not a 404 ([UPS-API#166](https://github.com/UPS-API/api-documentation/issues/166)). TOS forbids redistributing data to third parties and forbids sequential-number scanning. Cache the bearer token; re-minting per call is the usual cause of 429s. |
| **DHL** | [Shipment Tracking – Unified](https://developer.dhl.com/api-reference/shipment-tracking) | API key | Free | Default key: **250 calls/day, 1 call per 5 seconds**, resetting 24:00 GMT. Upgrade is a form in the dev portal. That 1-per-5s cap is the real constraint — 200 parcels ≈ 17 minutes of polling. |
| **ePost Global** | No self-serve *official* API — but **see §5.6, which is the answer we're using.** An official API does exist (Postman workspace "ePost Global – Track APIs/Webhooks", `postman.com/epostglobal/epost-global-shipping`); credentials come through an EPG account rep. | — | Free (§5.6) | **Service-level caveat:** several EPG parcel services (notably plain "Priority Parcel") provide **no real-time tracking events at all**. Any status feature has to tolerate permanently empty scan histories. |

**Aggregator alternative** — one integration instead of three, and it's the only
self-serve way to get EPG status:

| Provider | Entry cost | Per-parcel | Notes |
|---|---|---|---|
| **[EasyPost](https://support.easypost.com/hc/en-us/articles/360042414212-Billing-Payments)** standalone trackers | $0 (Free Access plan) | **$0.02** non-USPS / $0.03 USPS | No monthly minimum, no label purchase required. Cheapest honest entry for our volume. Supports EPG. |
| **[Ship24](https://www.ship24.com/pricing)** | Free tier includes API | ~$0.045 → $0.01 at scale | API on every tier including free. |
| **[TrackingMore](https://www.trackingmore.com/epgshipping-tracking-api)** | $74/mo (Pro) | $0.04 overage | EPG carrier code `epgshipping`. Credit = one parcel tracked unlimited times/month. |
| **[AfterShip](https://www.aftership.com/carriers/epostglobal/api)** | $70–119/mo | $0.08–0.12 | Most expensive; API gated behind Premium. |
| **[17TRACK](https://www.17track.net/en/pricing)** | ~$119 / 5,000, **annual prepaid** | ~$0.024 | Quota expires after 12 months, no rollover. A real-time refresh costs **10×** quota. Avoid. |

*All pricing is from vendor pages as of mid-2026 and several sources are competitor
comparison pages — confirm live before committing.*

**Recommendation (revised after §5.6):** we don't need a paid aggregator. EPG is free
via §5.6, UPS Track is free, DHL Unified is free. Keep EasyPost in the back pocket as
the paid fallback if §5.6 ever breaks and EPG won't issue API credentials.

### 5.3 Shopify order lookup — the big one

**There is no supported way to search orders by tracking number in the Shopify Admin
API.** `fulfillment_tracking_numbers:` is not a valid filter; the
[`orders` query](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders)
exposes ~40 filters and none of them touch tracking. The `fulfillment` query takes
only an `id`. The Shopify **admin UI** search bar *can* do it — that capability is
not exposed through the API. This is a long-standing, repeatedly-confirmed gap
([dev forum](https://community.shopify.dev/t/find-order-by-tracking-number/3247),
[community](https://community.shopify.com/t/how-to-search-for-an-order-by-tracking-number/142024/1)).

**Scope note added in v0.3:** this limitation now only binds **UPS and DHL**. EPG
parcels route around it entirely via `ERef` and the supported `name:` filter — see
§5.7. The index below is therefore a smaller job than it first appeared.

**The standard workaround, for UPS/DHL:** maintain our own index.

1. Subscribe to `FULFILLMENTS_CREATE` and `FULFILLMENTS_UPDATE` webhooks.
2. On each event, upsert `tracking_number → order GID` (plus order name, customer,
   destination) into our Postgres.
3. Scanning resolves against our own index — instant, offline-tolerant, no Shopify
   API call in the hot path.
4. Click-through calls `order(id:)` for the full live detail.

Side benefit: this is strictly better than live lookup anyway. It means a scan can be
enriched **the instant it's scanned** without adding a network round-trip per parcel,
and it lets us flag "this tracking number isn't in Shopify at all" — a mis-scan or a
wrong label — right at the desk.

**Cheap spike worth doing first (½ day):** the unqualified `orders(query: "1Z...")`
form does "a case-insensitive search of multiple fields." Whether tracking numbers are
in that index is undocumented. If it happens to work, Phase 2 collapses to almost
nothing. If not, we build the webhook index. Test before designing around it.

**Access prerequisites — verified against your store:**

I ran the orders query against `otc-shoppe-express.myshopify.com` using the stored
`shopify store` CLI token and got:

```
"message": "Access denied for orders field.", "code": "ACCESS_DENIED"
```

So, concretely:
- The current token has **no orders access**. We need `read_orders`, `read_fulfillments`,
  and — importantly — **`read_all_orders`**, because the default `read_orders` only
  sees the **last 60 days** and research requests arrive months later.
- `read_orders` is [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).
  Custom-distribution apps are treated leniently and generally already have the access
  levels, but it still has to be **configured and declared** in the dashboard.
- **2026 wrinkle:** custom apps created in the new **Dev Dashboard** (mandatory since
  2026-01-01) [may not expose a UI toggle for protected customer data](https://community.shopify.dev/t/enable-protected-customer-data-access-for-a-custom-app-created-in-the-dev-dashboard-no-ui-option-available/35445)
  — a Shopify support ticket is the reported workaround. Budget for a few days of
  latency here; this is the item most likely to slip.
- Custom app developer install links expire after **7 days**.

Your repo README already says `app/` exists "solely as the API credential" — that's the
right pattern. We either extend that app's scopes or create a fresh one.

### 5.4 Scan input — hardware scanner as keyboard wedge

A USB/Bluetooth laser scanner presents as a keyboard; a scan is indistinguishable from
very fast typing. The accepted heuristics, both implemented by
[onScan.js](https://github.com/axenox/onscan.js/) (vanilla, MIT) and
[use-scan-detection](https://github.com/markjaniczak/use-scan-detection) (React hook):

- Listen at the **document level**, not on a focused input — kills the fragile
  "keep a hidden input focused" pattern that breaks whenever someone clicks anything.
- Inter-keystroke threshold ~**50 ms** as the primary discriminator, plus a minimum
  length guard.
- Configure a **prefix and an Enter suffix in the scanner's own firmware** if possible
  — far more reliable than timing alone, and the suffix lets us commit immediately
  instead of waiting on a timeout.
- **Buffer in a `useRef`, not state.** Per-character `setState` thrashes React at
  scanner speeds.
- Suppress the trailing Enter so it doesn't submit the enclosing form.
- Handle paste-mode scanners (`reactToPaste`) — phone-based wedge apps paste rather
  than emit keystrokes.

No camera scanning in v1.

### 5.5 Prior art — nothing worth forking

I looked for an existing "scan parcels into a box, capture a master AWB, produce a
manifest" tool. It doesn't exist as standalone open source.

- **[OCA Shopfloor](https://github.com/OCA/wms)** (Odoo) is the closest — its
  Checkout/Packing scenario is genuinely this workflow — but it's inseparable from
  Odoo. Adopting it means adopting Odoo.
- **[OpenBoxes](https://github.com/openboxes/openboxes)** (Grails, healthcare WMS),
  **[infiniteoo/wms](https://github.com/infiniteoo/wms)** (Next.js, early) — full WMS
  platforms, orders of magnitude more than we need.
- **[PackageTrackr](https://github.com/DriftSolutions/PackageTrackr)** (MIT) — self-hosted
  package tracking; worth reading its carrier-priority matching, not worth adopting.

The EPG box/AWB consolidation model is specific to your operation. **Build it.** The
build is small; the research above is what saves the time.

### 5.6 Free ePost Global status — found and verified

**Answering Q5 ("can we do something free that scrapes EPG?"): yes, and it's much
better than scraping.**

`epgtrack.com` is a jQuery page, not a React SPA. It calls a single endpoint, and that
endpoint returns **fully structured JSON** (embedded in an HTML fragment's `onclick`
attribute) rather than markup we'd have to parse visually. I tested it end-to-end
against your real parcel `EPG030976227097798`.

**The endpoint:**

```
POST https://epgtrack.com/TrackingShipment/ShipmentData
Content-Type: application/x-www-form-urlencoded

id=EPG030976227097798,EPG030976227097799,...      # comma-separated, batched
```

**Verified characteristics** (curl, server-side, no browser):

| | |
|---|---|
| Auth | **None.** No API key, no cookie, no CSRF token, no session. |
| Batching | **Yes** — the page joins numbers with `,` (`values.join(",")` in `/js/index.js`). Confirmed working with 2. The UI caps input at 25; chunk at 25 to stay inside observed behaviour. |
| Latency | ~230 ms for a single lookup |
| Response | 200 + HTML fragment; the complete record is JSON inside `transactionDetails(...)` |
| Unknown numbers | Returned as a card in the batch rather than an error — parse defensively, don't assume 1 request = 1 result |

**The JSON payload per parcel** (real response, redacted only in that it's your data):

```json
{
  "ID": 55221447,
  "Ref": "EPG030976227097798",
  "ERef": "OSE83480X26",
  "Awb": "",
  "OCt": "US", "DCt": "ISRAEL", "DC": "IL", "Zipcode": "5560723",
  "Track": "", "ITrackNo": null, "VendorTrackingUrl": "", "VendorBaseUrl": "",
  "ModifiedDT": "2026-08-30T02:48:44.35",
  "Events": [
    { "ECategory": "In Transit to EPG", "ECategoryID": 28, "ECode": "EPGS01",
      "Event": "Shipment in Transit to the ePost Global Processing Center",
      "EventDT": "2026-08-29T21:27:53", "Loc": "", "Zip": "" },
    { "ECategory": "Data Received", "ECategoryID": 11, "ECode": "11",
      "Event": "Data Received", "EventDT": "2026-08-29T21:26:53", "Loc": "", "Zip": "" }
  ]
}
```

**Four fields here are worth more than the status itself:**

1. **`ERef: "OSE83480X26"` — ✅ CONFIRMED: this is the Shopify order name.**
   `ERef` is EPG's *external reference* field, and your label-printing process is
   populating it with the order number. This is the single most useful thing in the
   document — see §5.7 for what it unlocks.
2. **`Awb`** — EPG's own record of the airbill. Once populated we can **reconcile the
   AWB the packer typed against what EPG actually recorded**, which catches a
   mis-keyed AWB automatically.
3. **`Track` / `ITrackNo` / `VendorTrackingUrl`** — the **final-mile carrier's**
   tracking number in the destination country, populated after handoff. This is
   exactly what customer service needs for a "where is my parcel in Israel" question,
   and no other free source gives it to us.
4. **`ECategoryID`** — a stable numeric status taxonomy (11 = Data Received,
   28 = In Transit to EPG, …). Map these to our own status enum rather than
   string-matching `Event` text, which will change wording.

**Honest caveats — this is unofficial:**

- It is an undocumented internal endpoint. EPG can change or lock it down with no
  notice, and there's no SLA or support channel when it breaks. Treat a §5.6 failure
  as an expected event, not an outage: alert, fall back to link-out, keep going.
- We parse HTML to reach the JSON. Anchor the parser on `transactionDetails(` and the
  JSON structure, **not** on CSS classes or layout — the former is stable data, the
  latter is a redesign away from breaking.
- Be a good citizen, and it also keeps us under any rate limiting: batch 25 per call,
  one nightly pass, only for parcels not in a terminal state, hard cap the lookback
  window, set a real `User-Agent`, and never retry-storm.
- The data is **your own shipments**, which is the comfortable posture. Don't build
  anything that enumerates numbers you didn't ship.

**Do this in parallel:** ask your EPG account rep for real API credentials (the
Postman workspace shows there are proper Track APIs **and webhooks** — push beats
polling, and it's official and supported). §5.6 is the thing that works today with
zero dependencies; the official API is the thing that should work in a year. If the
rep comes through, swap the adapter behind the same interface.

### 5.7 EPG order lookup — a fully supported path that skips the webhook index

§5.3 established that Shopify has no API filter for tracking numbers. **`ERef` routes
around that entirely for EPG parcels**, because `name` *is* a documented, supported
filter on the `orders` query:

```
scan EPG030976227097798
  → §5.6 lookup  → ERef = "OSE83480X26"
  → orders(first: 1, query: "name:OSE83480X26")
  → the order
```

No webhooks, no index, no undocumented behaviour on the Shopify side — just two
supported calls chained together. `OSE83480X26` decomposes as Shopify's configurable
order **prefix** `OSE` + order number `83480` + **suffix** `X26`, which is why it
doesn't look like a stock `#1001`.

**This may be load-bearing rather than merely convenient.** You print EPG labels
yourselves, which raises a question I can't answer from here (Q10): *do EPG tracking
numbers ever get written back into Shopify as fulfillment tracking?* If they don't,
then a webhook index built on `FULFILLMENTS_CREATE` would silently cover only your
UPS and DHL parcels and quietly miss every EPG one — the largest share of your volume.
`ERef` closes that gap and is unaffected by the answer either way.

**One timing caveat.** `ERef` is only available once EPG has received the label data.
On the parcel I tested, "Data Received" landed at 21:26 and "In Transit to EPG" one
minute later — so the record existed well before the box moved. But if your data
upload is an end-of-day manifest rather than at print time, `ERef` won't be there at
the moment of scanning. That's a soft failure, not a blocker: the nightly cron (§8.9)
backfills it, so order enrichment appears the next morning instead of instantly.

---

## 6. Architecture decision: Shopify app vs. Vercel

These are actually **two separate questions** that get conflated:

1. **Where does the UI live?** — standalone site vs. embedded in Shopify admin.
2. **How do we talk to Shopify?** — you need a Shopify **custom app** for API access
   *either way*. That's not optional and not related to question 1.

So the real question is only #1.

### Standalone on Vercel

**Good**
- **Ships in days, not weeks.** No App Bridge, no session-token plumbing, no OAuth
  install flow, no iframe/third-party-cookie constraints. Phase 1 becomes a one-week
  build instead of two-to-three.
- **Full-screen scan UI.** The admin iframe is a cramped, chrome-heavy container. A
  scan station wants a big number, a big count, and nothing else.
- **Packers never need Shopify admin access.** No staff seats, and — more importantly
  — nobody at the packing bench gets a login to your 10,000-product storefront admin.
  With an embedded app, every scanner user needs a Shopify staff account.
- **Kiosk-friendly.** Tablet stays logged in on a shared passcode; no Shopify session
  to expire.
- Effectively free hosting; Postgres via Supabase or Neon (you already have Supabase
  wired up).

**Bad**
- We build our own auth. For 2–3 people this is a shared passcode or Google sign-in —
  an afternoon, not a project.
- Second place to log in.
- We own the Shopify token lifecycle. Custom-app tokens are long-lived, so this is
  minor, but it's ours.
- If you ever wanted to *sell* this to other merchants, distribution would have to be
  rebuilt as a public app.

### Embedded Shopify app

**Good**
- SSO — staff are already authenticated in the admin.
- Native deep-links to orders; the admin's own order search sits right there.
- A path to selling it later, if that ever becomes interesting.
- Access to Shopify POS scanner hardware if you go that route.

**Bad**
- **~1–2 weeks of scaffolding before a single feature works**: OAuth install, App
  Bridge, session-token auth, Polaris. That's most of Phase 1's budget spent on
  plumbing.
- Embedded apps [must work without third-party cookies or localStorage](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
  including incognito. Real constraint on a scan buffer.
- Every packer needs a Shopify staff account with app permission → seat cost on some
  plans, and admin exposure you probably don't want.
- **It doesn't solve the actual hard problem.** Embedding does not give you order
  search by tracking number (§5.3) — you build the webhook index regardless.

### Recommendation

**Standalone Next.js on Vercel + a Shopify custom app used purely as a server-side API
credential.** It's the faster path to the quick win, it keeps warehouse staff out of
your store admin, and it costs nothing to reverse — a Next.js app can be wrapped in
App Bridge in Phase 4 if you ever decide you want it in the admin. Going the other
direction (unwinding an embedded app into a standalone one) is the expensive one.

---

## 7. Data model (Phase 1)

```
app_user
  id              uuid pk
  name            text                   -- shown on scans: "Mai", "Tou"
  pin_hash        text                   -- 4-digit PIN, hashed (bcrypt/argon2)
  is_admin        bool default false
  active          bool default true      -- deactivate, never delete (scans reference it)
  unique (pin_hash) enforced in app layer -- PINs must be unique; see §8.9

shipment_session
  id                  uuid pk
  opened_at           timestamptz
  opened_by           fk -> app_user
  submitted_at        timestamptz null   -- null = still open
  submitted_by        fk -> app_user null
  ship_date           date               -- defaults to opened_at, editable on submit
  notes               text
  status              enum(open, submitted, voided)
  awb_number          text null          -- ONE AWB per consolidated EPG shipment
  master_ups_tracking text null          -- ONE UPS master; accounts for every box

box                                      -- ePost Global consolidation only
  id              uuid pk
  session_id      fk -> shipment_session
  box_number      int                    -- 1, 2, 3… within the session
  ups_tracking    text null              -- OPTIONAL per-box piece tracking
  unique (session_id, box_number)

scan
  id                uuid pk
  session_id        fk -> shipment_session
  box_id            fk -> box null       -- null for direct UPS/DHL parcels
  scanned_by        fk -> app_user
  tracking_number   text
  carrier           enum(epg, ups, dhl, unknown)
  scanned_at        timestamptz
  sequence          int                  -- scan order within session
  order_gid         text null            -- Phase 2
  order_name        text null            -- Phase 2, denormalized for search
  epg_external_ref  text null            -- EPG's ERef = Shopify order name (§5.7)
  epg_final_mile    text null            -- EPG's final-mile carrier tracking (§5.6)
  status_code       text null            -- normalized; from ECategoryID / UPS / DHL
  status_label      text null
  status_at         timestamptz null
  status_checked_at timestamptz null
  unique (tracking_number)               -- global; powers the duplicate rule (§8.3)
```

**Why `master_ups_tracking` sits on the session, not the box** (confirmed): the EPG
consolidation ships as a **UPS multi-piece shipment**. There is one master tracking
number that accounts for every box; additional boxes have their own piece-level
numbers, but the master covers them. So the master is required and per-shipment, and
`box.ups_tracking` is an *optional* convenience field — capture it if the packer has
it, don't block submit on it.

---

## 8. Phase 1 — the quick win

**Target: ~1.5 weeks. No Shopify dependency.** Everything here works without a Shopify
token and without waiting on a Shopify support ticket. That's deliberate — Phase 1
must not be blocked by §5.3's approval latency. The only external call is §8.9, which
needs no credentials at all.

### 8.1 Sign in — 4-digit PIN
- Landing on `/` shows a numeric keypad. Type a 4-digit PIN → you're in, identified.
  No username, no password, no email. One motion, works with gloves on a tablet.
- The PIN **identifies the user**, so PINs must be **globally unique** — the admin
  screen rejects a PIN already in use rather than silently creating an ambiguous login.
- Admin screen (admin-only): add user, set/reset PIN, toggle admin, deactivate.
  **Deactivate, never delete** — historical scans reference the user.
- Session cookie is httpOnly and long-lived (a warehouse tablet shouldn't log out
  mid-shift), with an explicit "Switch user" button in the header.
- **Security posture, stated plainly:** a 4-digit PIN is 10,000 combinations. This is
  *identification for attribution*, not real authentication — appropriate for a
  warehouse kiosk on your network, not for anything internet-exposed and sensitive.
  Mitigations: rate-limit to ~5 attempts per minute per IP, lock out for 15 minutes
  after 10 failures, hash PINs at rest, and log every failed attempt. If the app ends
  up on the open internet, put it behind Vercel password protection or a Cloudflare
  Access rule as an outer gate — the PIN then only decides *which packer*, which is
  exactly what you asked it to do.

### 8.2 Session
- After sign-in, a session opens automatically, or resumes today's open session if one
  exists (avoids losing 60 scans to an accidental refresh).
- Session state persists server-side on every scan — a browser crash loses nothing.
- `opened_by` is the signing-in user; each individual scan also records `scanned_by`,
  so a second packer can "Switch user" mid-session and attribution stays correct.

### 8.3 Scanning
- Single large scan field, document-level wedge listener per §5.4.
- Newest scan at the top of the list, with an undo on each row.
- Audible/visual confirmation per scan — a green flash and a beep. Packers watch the
  parcel, not the screen. **The duplicate tone must be audibly different** from the
  accept tone; that's the only feedback a packer looking at a box will register.

### 8.4 Validation and duplicate handling
Checks run in order at scan time:

1. **Unrecognized format** → red, "Not a recognized EPG/UPS/DHL tracking number,"
   offer manual carrier assignment.
2. **Failed check digit** (UPS/DHL, via `ts-tracking-number`) → amber, "Looks like a
   misread — rescan?" with an override.
3. **Duplicate.** Two distinct cases, deliberately handled differently:

   **(a) Already in *this* session — silently disregard.** Per your instruction: the
   packer double-scanned the same parcel. No second row is created, the count does not
   move. Feedback is a brief neutral toast, not an error: *"Already scanned — Box 2."*
   Naming the box matters: if the packer is standing at Box 3 and the parcel is
   recorded in Box 2, that's worth knowing, so the toast carries a **"Move to Box 3"**
   button. Default action is still to ignore; the button just means the information
   isn't lost.

   **(b) Already in a *previous, submitted* shipment — loud, blocking.** This one is
   **not** disregarded. It means a parcel is recorded as having gone out on a day it
   didn't, which is exactly the kind of bad data this app exists to prevent. Red,
   names the date: *"Already shipped 2026-08-24, Box 2 — scanned by Mai."* Requires an
   explicit admin override to add anyway. I've assumed this is what you want; if
   reships or relabels genuinely reuse a number, say so and it drops to a warning.

### 8.5 Boxes (ePost Global only)
- Box 1 is active by default. **New Box** increments; clicking a box chip re-activates
  that box for corrections.
- EPG scans land in the active box. UPS and DHL scans **bypass boxes entirely** — they
  just go on the session list. Same input field, no mode switching, no thinking.

### 8.6 Live session dashboard

Always visible while the session is open, at the top of the scan screen, sized to be
read from a few feet away — the packer is looking at parcels, not leaning into a
screen. All counts are **unique tracking numbers** (duplicates per §8.4 never
increment anything).

**Row 1 — per-carrier totals:**

```
   EPG              UPS              DHL            SESSION
   47               12                3               62
```

**Row 2 — per-box breakdown (EPG only), the part you asked for.** One chip per
20×20×20 box, active box highlighted, so the packer always knows how many packages are
in the box in front of them:

```
  [ BOX 1   24 ]   [ BOX 2   23 ]   [ ▶ BOX 3   9 ]   [ + New Box ]
```

- The active box's count is the largest number on the screen — it's the one being
  answered ("how many are in this box right now?").
- Clicking a chip makes that box active and filters the scan list to it.
- Invariant shown live: **sum of box counts always equals the EPG total.** If they
  ever diverge, something is wrong and the dashboard should say so rather than quietly
  disagree with itself.
- Optional, cheap, say if you want it: an admin-set **target count per box** that
  turns a chip amber past the target — useful if a 20×20×20 reliably holds ~N parcels.
  Left out by default since I don't know your real number.

### 8.7 Submit
Two required fields, both at shipment level — not repeated per box:

- **AWB** — one per consolidated EPG shipment.
- **Master UPS tracking** — one per shipment. It's a UPS multi-piece shipment, so this
  number accounts for every box.
- **Per-box piece tracking** — *optional*. A collapsed "add per-box tracking numbers"
  section for the packer who has them handy. Never blocks submit; the master covers it.
- Ship date (defaults today), notes. Operator comes from the PIN, not a text field.
- Blocking validation: a box with 0 scans can't submit; a session containing EPG scans
  can't submit without both the AWB and the master UPS tracking.
- On submit the session locks. Corrections after submit go through an explicit
  "reopen" that's recorded with who and when — never a silent edit.

### 8.8 History and search
- `/shipments` — reverse-chronological list: date, per-carrier counts, box count, AWB.
- `/shipments/{id}` — full detail, boxes expanded, every scan listed.
- **Global search** on tracking number across every session ever. Paste a number, get
  the shipment, box, and date. This is the feature that replaces "digging through
  Shopify."
- Every tracking number renders as a link to the carrier's own page:
  `https://epgtrack.com/{n}` · UPS · DHL.
- **CSV export per shipment.** This is the deliberate stand-in for everything not yet
  built — until Phase 2, the export is how you reconcile against anything else.

### 8.9 ePost Global status — pulled forward from Phase 3

Because §5.6 turned out to be free and unauthenticated, EPG status is now roughly a
day of work instead of a paid integration, so it belongs in the first release. **Treat
it as a stretch item:** it has zero dependencies on §8.1–8.8, so if week one gets
tight, cut it and ship the rest.

- Adapter posting to `epgtrack.com/TrackingShipment/ShipmentData`, 25 numbers per
  batch, parsing the JSON out of `transactionDetails(` per §5.6.
- Vercel Cron, once nightly: refresh every EPG scan not in a terminal state, capped to
  a 45-day lookback.
- Persist `status_code` (mapped from `ECategoryID`, not from `Event` wording),
  `status_label`, `status_at`, plus `epg_external_ref` and `epg_final_mile`.
- Status column in history and shipment detail. **"No tracking available for this
  service"** is a distinct state from "no movement" — several EPG services never emit
  events at all (§5.2), and conflating the two produces false alarms.
- Failure of this endpoint must be non-fatal and visible: log it, surface a small
  "EPG status unavailable" banner, keep the link-out working. Everything else in the
  app keeps functioning.
- UPS and DHL status stay in Phase 3. The link-out covers them meanwhile.

### 8.10 Stack
Next.js (App Router) on Vercel · Postgres on Supabase · Drizzle or Prisma ·
Tailwind · `ts-tracking-number` for checksums · PIN auth with hashed PINs in an
httpOnly cookie session · Vercel Cron for §8.9.

### 8.11 Phase 1 acceptance criteria
- [ ] Sign in with a 4-digit PIN in one motion; the header shows who you are.
- [ ] Admin can add a user, and is blocked from assigning a PIN already in use.
- [ ] Scan 50 mixed EPG/UPS/DHL labels with a hardware scanner — zero clicks between
      scans, zero misclassifications.
- [ ] EPG scans distribute correctly across 3 boxes; **box counts always sum to the
      EPG total**, and the active box count is legible from 6 feet away.
- [ ] Double-scanning the same parcel in-session creates **no** second row, does
      **not** move any count, and plays a distinct tone.
- [ ] Rescanning a number from a *previous submitted* shipment blocks loudly and names
      the prior date, box, and packer.
- [ ] Submit with one shipment-level AWB + one master UPS tracking; session appears in
      `/shipments`.
- [ ] Search a tracking number from two weeks ago and land on its shipment, box, and
      packer in under 5 seconds.
- [ ] Hard-refresh mid-session loses nothing. "Switch user" mid-session attributes
      subsequent scans to the new packer.
- [ ] CSV export opens cleanly in Excel.
- [ ] *(stretch, §8.9)* Overnight cron populates EPG status; a service with no tracking
      events reads "no tracking available," not "stuck."

### 8.12 Explicitly out of Phase 1
Shopify order lookup · UPS/DHL live status · camera scanning · label/manifest
printing · granular roles beyond user/admin.

---

## 9. Phase 2 — Shopify order lookup (~1 week, gated on access approval)

**Start the access request on day 1 of Phase 1** — §5.3's protected-customer-data
approval is the long pole and may need a support ticket.

The phase now splits cleanly in two, because EPG and UPS/DHL reach Shopify by
different routes. **Ship 2a first — it covers the bulk of your volume and needs no
webhook infrastructure at all.**

**Step 0 — access (blocking, start on day 1 of Phase 1).** Custom app with
`read_orders`, `read_fulfillments`, and `read_all_orders`; protected customer data
configured. Currently returns `ACCESS_DENIED` (§5.3).

### 9a. EPG parcels — via `ERef` (~2 days)

Fully supported API path, no webhooks, no index (§5.7):

1. Persist `epg_external_ref` from the §8.9 status cron (already being fetched).
2. Resolve with `orders(first: 1, query: "name:<ERef>")` — `name` is a documented
   filter. Cache the resulting order GID and name on the scan row.
3. Handle the miss cases explicitly rather than silently: `ERef` empty (data not yet
   uploaded — retry next cron), and `ERef` present but no matching order (a genuine
   data problem worth surfacing).

### 9b. UPS and DHL parcels — via the webhook index (~3 days)

These have no external reference, so §5.3's index is still required:

1. `FULFILLMENTS_CREATE` + `FULFILLMENTS_UPDATE`, HMAC-verified, upserting
   `tracking_number → {order_gid, order_name, customer, destination}`. Idempotent on
   `X-Shopify-Webhook-Id` — Shopify redelivers.
2. One-time backfill paging orders from the last N months.
3. Optional ½-day spike, pure upside: does bare `orders(query: "<tracking>")` full-text
   match? Undocumented. If it works, 9b gets a live fallback for gaps in the index.

### 9c. Shared UI

4. **Scan-time enrichment:** order name and destination appear beside the scan as it's
   read, resolved locally with no per-scan network call. A tracking number that
   resolves to *no* order is surfaced as a warning — a mis-scan or a wrong label,
   caught at the bench instead of a month later.
5. **Click-through:** any tracking in history opens an order panel — order #, date,
   customer, line items, ship-to, and a deep link into the Shopify admin.

**Acceptance:** click any tracking number in any historical shipment and see the full
order without opening Shopify — for all three carriers. Orders older than 60 days
resolve correctly.

---

## 10. Phase 3 — UPS + DHL status, and the exceptions view

EPG status already landed in Phase 1 (§8.9). This phase completes the picture and adds
the screen that makes status *useful* rather than merely present. **Still $0** — both
remaining APIs are free.

- **UPS Track API** behind the same status-adapter interface as §8.9. OAuth 2.0 client
  credentials; **cache the bearer token**, don't mint one per call. Detect
  not-found/not-yet-scanned by reading `warnings[].code == "TW0001"` — UPS returns
  **HTTP 200** for these, so status codes tell you nothing (§5.2).
- **DHL Shipment Tracking – Unified.** Request the rate-limit upgrade on day 1; the
  default key is 250/day at 1 call per 5 seconds, which paces a 200-parcel refresh at
  ~17 minutes. Even unupgraded that's survivable for a nightly cron — just make the
  job resumable and don't let it stampede.
- Extend the nightly cron to all three carriers, still skipping terminal states,
  still capped at a 45-day lookback.
- **Exceptions view** — the screen that turns the app from a log into a tool:
  in-transit beyond N days, returned, exception, and never-scanned-by-carrier
  (a label created but never handed over — the failure mode nobody notices).
- Escape hatch, unchanged: if §5.6 breaks and EPG won't issue credentials,
  **EasyPost standalone trackers** at ~$0.02/parcel with no subscription drops in
  behind the same interface.

---

## 11. Phase 4 — later, if wanted

Camera scanning on phones (`html5-qrcode` / ZXing) · printed per-box manifests to go
inside the master carton · per-packer throughput stats (free now that every scan has a
`scanned_by`) · AWB reconciliation against EPG's own `Awb` field (§5.6) · surfacing
the final-mile carrier tracking number to customer service · delivery-rate and
transit-time dashboards · Slack/email alerts on exceptions · wrapping the app in App
Bridge to embed in the Shopify admin.

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Shopify protected-customer-data approval stalls (§5.3) | Phase 2 slips | Phase 1 has zero Shopify dependency by design. Start the request on day 1. |
| `orders(query:)` full-text doesn't match tracking numbers | +3 days | Webhook index is the plan of record; the spike is upside, not a dependency. |
| **§5.6 EPG endpoint changes or is locked down** | EPG status stops updating | Highest-likelihood technical risk in the doc — it's undocumented and unsupported. Parser anchored on JSON structure, not CSS. Failure is non-fatal by design (§8.9). Fallbacks in order: EPG official API via account rep → EasyPost ~$0.02/parcel → link-out only. |
| EPG service levels with no tracking events | Confusing "stuck" shipments | Explicit "no tracking for this service" state, distinct from "no movement" (§8.9). |
| **`ERef` not yet populated when the packer scans** | EPG order enrichment is delayed, not instant | Soft failure by design: the nightly cron backfills it, so the order appears next morning. Q11 (the label printer's own record) would remove this entirely. |
| **`ERef` is only as good as the label-printing process** | An order shipped with a blank or wrong `ERef` has no link | Surface "no order matched" as a visible state rather than an empty cell, so a broken label run is noticed on day one. |
| Misread scan creates a phantom record | Bad data, silently | Check-digit validation + duplicate rules + per-row undo (§8.4). |
| **In-session duplicates silently ignored (§8.4a)** | A genuinely different parcel with a colliding number would vanish | Accepted per your instruction, and near-impossible in practice given carrier-unique numbers. The toast still names the box it's already in, so it's visible rather than truly silent. |
| Scanner firmware differs from assumptions | Scanning feels broken | Configure prefix + Enter suffix in firmware; support paste-mode; make thresholds configurable. |
| DHL 1-call-per-5s cap | Slow nightly refresh | Request the upgrade on day 1; make the cron resumable. Not user-facing either way. |
| **4-digit PIN is weak auth** | Anyone who guesses 4 digits is "a packer" | Acceptable for attribution on a warehouse kiosk; rate-limit + lockout + hashed at rest. If internet-exposed, put an outer gate in front (§8.1). |
| PIN reuse across users | Ambiguous attribution | Uniqueness enforced at the admin screen (§8.1). |

---

## 13. Open questions

### Answered

**Q1 — AWB scope. ✅ One AWB per consolidated shipment.** On `shipment_session`.

**Q1a — AWB across days. ✅ Never.** Different day, different AWB. One session = one
day = one AWB confirmed, so no layer above the session is needed.

**Q1b — UPS master tracking. ✅ One per shipment (UPS multi-piece).** All EPG boxes
ship under one master tracking that accounts for the rest; per-box piece numbers are
captured optionally and never block submit (§7, §8.7).

**Q3 — Duplicates. ✅ A tracking number should never appear twice.** In-session
re-scans are silently disregarded; duplicates against a previously submitted shipment
block loudly (§8.4). Global uniqueness constraint retained.

**Q5 — Free EPG tracking. ✅ Yes — found, tested, documented in §5.6.** No scraping of
rendered HTML required; there's a free, unauthenticated, batchable endpoint returning
structured JSON. Phase 3's cost estimate drops to $0 and EPG status moves into Phase 1.

**Q6 — Access. ✅ 4-digit PIN identifies the user; admin manages users and admin
flags** (§8.1). Named-user attribution therefore moves from Phase 4 into Phase 1, and
`scanned_by` lands on every scan, not just the session.

**Q7 — What is EPG's `ERef`? ✅ The Shopify order name.** `ERef` is EPG's *external
reference* field; your label printing populates it with the order number. This gives
EPG parcels a fully supported Shopify lookup path via `orders(query: "name:...")`
with no webhook index (§5.7), and splits Phase 2 into 9a/9b.

**Q9 — Who prints the EPG labels? ✅ You do, in-house.** Which is why `ERef` is
populated with your order number at all — see Q11 for the follow-up worth chasing.

### Still open

**Q2 — Can a session span more than one ship date?** Assumed no: one session = one
day's outbound = one submitted record. Q1a strongly implies this is right; confirm.

**Q4 — Do UPS/DHL parcels need any grouping at all?** Assumed no per your description
— they're just recorded against the session. Confirm there's no per-driver-pickup or
per-manifest grouping you'd want later.

**Q8 — Typical and peak parcels per day?** No longer a cost question (everything is
free now), but it sets the cron batch sizing and tells me whether the per-box target
count in §8.6 is worth building.

**Q10 — NEW, and now the most consequential one: do EPG tracking numbers ever get
written back into Shopify as fulfillment tracking?** Since you print EPG labels
in-house, they may never reach Shopify at all. This decides how much §9b actually
covers: if EPG fulfillments *aren't* in Shopify, then a webhook index alone would
silently cover only UPS/DHL and miss your largest carrier — which is exactly why §9a
exists. Easy check: open a recent EPG order in the Shopify admin and see whether the
`EPG…` number appears on the fulfillment.

**Q11 — What software prints your EPG labels, and does it keep a
tracking-number ⇄ order-number record you could export?** If it does, that's a more
direct and more reliable source than reading `ERef` back out of EPG's tracking site,
and it would be available at print time rather than after EPG ingests the data — which
would also remove §5.7's timing caveat. Worth 10 minutes of looking before I build
§9a.

---

## 14. Sources

Carrier detection —
[tracking_number_data](https://github.com/jkeen/tracking_number_data) ·
[ts-tracking-number](https://www.npmjs.com/package/ts-tracking-number) ·
[shipmethod](https://github.com/cyberwombat/shipmethod) ·
[PackageTrackr](https://github.com/DriftSolutions/PackageTrackr)

Carrier APIs —
[UPS OAuth client credentials](https://developer.ups.com/tag/OAuth-Client-Credentials) ·
[UPS-API issue #166 (TW0001 / HTTP 200)](https://github.com/UPS-API/api-documentation/issues/166) ·
[DHL Shipment Tracking – Unified](https://developer.dhl.com/api-reference/shipment-tracking) ·
[DHL rate limits](https://support-developer.dhl.com/support/solutions/articles/47001242738-what-is-the-daily-rate-limit-and-spike-arrest-how-does-it-work-) ·
[DHL Unified free of charge](https://support-developer.dhl.com/support/solutions/articles/47001249492-is-the-dhl-shipment-tracking-unified-api-free-of-charge-)

ePost Global —
**§5.6 endpoint: verified first-hand on 2026-08-30** against `EPG030976227097798` via
browser network capture and server-side `curl`; request shape read from
`https://epgtrack.com/js/index.js` ·
[EPG Postman: Track APIs/Webhooks](https://www.postman.com/epostglobal/epost-global-shipping/documentation/hihkmvj/epost-global-track-apis-webhooks) ·
[EPG portal](https://portal.epgshipping.com/) ·
[EasyPost ePost Global guide](https://docs.easypost.com/carriers/epost-global-guide) ·
[TrackingMore EPG API](https://www.trackingmore.com/epgshipping-tracking-api) ·
[AfterShip EPG API](https://www.aftership.com/carriers/epostglobal/api)

Aggregator pricing —
[EasyPost billing](https://support.easypost.com/hc/en-us/articles/360042414212-Billing-Payments) ·
[EasyPost trackers](https://docs.easypost.com/docs/trackers) ·
[Ship24 pricing](https://www.ship24.com/pricing) ·
[17TRACK plan details](https://help.17track.net/hc/en-us/articles/37575217580825-Plan-Details)

Shopify —
[orders query reference](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders) ·
[Find order by tracking number (dev forum)](https://community.shopify.dev/t/find-order-by-tracking-number/3247) ·
[How to search for an order by tracking number](https://community.shopify.com/t/how-to-search-for-an-order-by-tracking-number/142024/1) ·
[Work with protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) ·
[Access scopes](https://shopify.dev/docs/api/usage/access-scopes) ·
[Dev Dashboard protected-data gap](https://community.shopify.dev/t/enable-protected-customer-data-access-for-a-custom-app-created-in-the-dev-dashboard-no-ui-option-available/35445) ·
[App distribution](https://shopify.dev/docs/apps/launch/distribution) ·
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) ·
[Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements)

Scanning —
[onScan.js](https://github.com/axenox/onscan.js/) ·
[use-scan-detection](https://github.com/markjaniczak/use-scan-detection)

Prior art —
[OCA Shopfloor / WMS](https://github.com/OCA/wms) ·
[OpenBoxes](https://github.com/openboxes/openboxes) ·
[infiniteoo/wms](https://github.com/infiniteoo/wms)
