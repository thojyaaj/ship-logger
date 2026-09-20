# Carrier invoice audit

Compares what a carrier billed for each parcel against what ShipStation
quoted when the label was bought. Admin-only, at **Invoices** in the header
(`/admin/invoice-audits`).

EPG is supported today. UPS and DHL invoices have different layouts and will
each need their own parser next to `lib/invoice-audit/epg-parse.ts`.

## How a parcel is judged

Each invoice line is matched to a scan by EPG label number (`refno` →
`scan.tracking_number`), falling back to the final-mile tracking number
(`trackingno` → `scan.epg_final_mile`). The quote is the scan's
`shipstation_cost_amount`. If the scan has no cost yet, or the parcel was
never scanned, ShipStation is checked live (up to 80 lookups per audit).

| Status | Meaning |
|---|---|
| Overcharged | Billed more than quoted by over $0.05 |
| Billed twice | Same EPG label appears twice on this invoice, or was already billed on an earlier audited invoice. The whole amount counts as an overcharge |
| Undercharged | Billed less than quoted by over $0.05 |
| Matches quote | Within $0.05 |
| No quote | Found, but ShipStation has no cost on the label, or the lookup limit was hit (see Re-check below) |
| Currency differs | The quote and invoice are in different currencies, so they aren't compared |
| Not found | Not scanned in ship_logger and no ShipStation label |

Separately, a line is flagged **billed heavier** when EPG's billed weight
exceeds the ShipStation label weight by more than 10% (minimum 0.1 lb).
Weights on the EPG sheet are pounds and dimensions are inches.

Each audit makes at most 80 live ShipStation lookups, so on a big invoice
some parcels can end up "No quote" with a note that the lookup limit was
hit. The **Re-check unverified parcels** button on the audit re-checks just
the unverified parcels in place. It uses any costs the nightly labels cron
has saved since, then up to 80 more live lookups per click, starting with
parcels that were never looked up. Click it again until nothing is left to
check.

A nightly job (`/api/cron/invoice-recheck`, 9:35 UTC, after the labels
cron) does the same re-check automatically for every audit from the last
30 days that still has unverified parcels, newest first, sharing one
budget of 80 live lookups per night. After 30 days an audit is left alone,
since a parcel still without a cost by then almost never gets one. The
button still works on it.

Uploading an invoice that was already audited re-runs it from scratch and
replaces the old result. That doesn't help with the lookup limit, because
it starts over in the same order. Email intake never replaces: a re-sent
invoice is ignored.

## Shipping profit / loss

Alongside the billing audit, each parcel shows whether shipping made or
lost money:

> what the customer paid for shipping − Fruugo's 20% fee − what EPG billed

- **Customer paid:** the shipping charge on the parcel's matched Shopify
  order. It comes from the scan's own order data or, if the parcel was
  never scanned (or its scan has no order yet), from Shopify's
  fulfillment records, looked up by the invoice's EPG reference or
  final-mile tracking number. If the order shipped as several parcels,
  the charge is split evenly across them, so it isn't counted more than
  once.
- **Fruugo fee:** a flat 20% on every EPG parcel, since every EPG order is
  a Fruugo sale. Set by `MARKETPLACE_FEE_RATE` in
  `lib/invoice-audit/format.ts`.
- **Billed twice:** a duplicate charge earns nothing, so its whole billed
  amount counts as a loss.
- **No order data:** parcels with no matched order are left out of the
  totals and counted separately, not treated as $0. The audit page says
  how many parcels matched a scan and why the rest didn't (not scanned,
  scanned but no order yet, or a different currency), and each blank
  shows its reason.
- **Ship date** comes from the shipment the parcel was scanned into. For
  a parcel that was never scanned, it comes from ShipStation's label, and
  is marked "(ShipStation)".

### Looking up unscanned parcels

For parcels with no scan, or a scan with no order, the audit page shows
**Look up orders & dates**. It follows this chain:

1. **EPG** is asked about the parcel's EPG reference (one batched call for
   the whole run). Its answer includes the order's `ERef`, which is the
   **Shopify order name** (e.g. `OSE79987X25`), the same "Order #" that
   ShipStation shows.
2. **Shopify** is asked for that order's shipping charge.
3. **ShipStation** supplies the ship date from the parcel's label (only
   for parcels with no scan, which already know their shipment's date).

If EPG has no record, ShipStation's shipment `external_order_id` is tried
instead. ShipStation's API doesn't carry what the customer paid, and its
order id is often empty for orders imported by a store integration, so it
is a backup rather than the main route.

Each click looks up to 40 parcels. A nightly job
(`/api/cron/invoice-enrich`, 9:38 UTC) does the same across all audits,
newest invoice first.

What was found, or why not, is saved on the audit line, so nothing is
looked up twice. A blank shows a short reason: *no order ref found* or
*order not in Shopify*, with the full note on hover. A lookup that ended
in a note is tried again after 7 days; an API failure is retried on the
next run. Figures found this way are labeled "via order lookup".

## Analytics

The top of the Invoices page totals every audited invoice:
- **Headline figures:** net loss or gain, total overcharged and
  undercharged, and the share of verified parcels that were overcharged.
- **Net per invoice:** a chart of the latest 24 invoices. Bars above the
  line are losses and bars below are gains. Click a bar to open that audit.
- **Overcharges by cause:** each overcharged parcel is counted once, under
  the first of these that applies: billed twice, billed heavier than the
  label, charged surcharges or fees, or otherwise a rate above the quote.
- **Overcharges by destination:** the top 6 countries.

Unverified parcels aren't counted until they're re-checked.

## Gmail automation (Apps Script)

EPG emails the package-detail .xlsx with each invoice. A Google Apps Script
in that Gmail account posts each new one to ship_logger hourly, and
ship_logger emails a summary (via the existing Resend alert setup, to
`ALERT_TO_EMAILS`).

### One-time setup

1. **Generate a secret** (on your Mac):
   ```bash
   openssl rand -hex 32
   ```
2. **Vercel**: add `INVOICE_INTAKE_SECRET_GMAIL` = that value to the
   Production environment, then redeploy.
3. **Apps Script**: signed into the Gmail account that receives EPG
   invoices, go to [script.google.com](https://script.google.com) → New
   project. Paste in `scripts/apps-script/epg-invoice-intake.gs`, replacing
   the starter code. **Don't edit the code.** The values below go in
   Script Properties, not in the script. Putting the URL in the code
   produces "Script property https://… is not set".
4. **Project Settings (gear icon) → Script Properties**, add these as
   name/value rows:
   - `SHIPLOGGER_URL` = `https://ship.otcshoppeexpress.com`
   - `INVOICE_INTAKE_SECRET` = the same secret
   - `EPG_SENDER` = the address EPG invoices come from
   - `LOOKBACK_DAYS` (optional) = how many days back to look, default `60`
5. In the editor, select `processEpgInvoices` and click **Run** once. Google
   will ask you to authorize Gmail and external-request access. Check the
   execution log, then the Invoices page.
6. Select `installHourlyTrigger` and click **Run** once to schedule it.

### What the script does each run

The execution log starts with a line like "Found 7 EPG invoice email(s)
… in the last 60 days; 7 already handled, 0 to send". If it says 0 to
send, there's nothing new. That's normal, not a failure.

The script keeps its own list of emails it has handled, in the Script
Properties. It doesn't rely on Gmail labels, because Gmail labels whole
conversations: if EPG's emails thread together, a new invoice in an
already-labeled conversation would otherwise be skipped. The labels are
only there for you to see:

- `ShipLogger/Audited`: sent and accepted (or already audited).
- `ShipLogger/Rejected`: ship_logger couldn't read the attachment as an
  EPG invoice. Upload it by hand if it's a real invoice.

A failed send (network error, site down) isn't recorded, so the next run
retries it. Each run sends for up to 4 minutes and leaves the rest for the
next hourly run.

### Older invoices

Set the `LOOKBACK_DAYS` Script Property, e.g. `365` for a year, and run
`processEpgInvoices`. The next few hourly runs work through the backlog.
Invoices that were already audited are skipped. To send everything in the
window again, run `forgetProcessedEmails` once. The server still skips
invoices it has already audited.

### Alerts when intake goes quiet

Two emails, sent to `ALERT_TO_EMAILS` like the other alerts:
- **An invoice couldn't be read.** The email is labeled
  `ShipLogger/Rejected` and isn't retried, so without this an EPG format
  change would silently stop audits. The alert names the file and reason;
  upload it by hand meanwhile.
- **No invoice received from Gmail in 14 days.** Sent from the nightly
  invoice-recheck cron, then weekly while it stays quiet. It usually means
  the Apps Script's trigger or Google authorization stopped. The email
  lists what to check. Ignore it if EPG simply hasn't invoiced.

### Security

The endpoint (`POST /api/v1/invoices/epg`) accepts only HMAC-signed
requests. The signature covers the method, path, timestamp and a hash of
the file, and requests more than 5 minutes old are rejected. See
`lib/invoice-audit/intake-auth.ts`. To rotate the secret, update both the
Vercel env var and the Script Property.

Gmail's spam filtering is what stops spoofed "EPG" emails, since the script
trusts the sender filter. The worst a spoofed invoice could do is create a
bogus audit under a real invoice number, which would make the genuine email
be skipped as a duplicate. Re-uploading the real file replaces it.
