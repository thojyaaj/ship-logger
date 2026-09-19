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

Uploading an invoice that was already audited re-runs it from scratch and
replaces the old result. That doesn't help with the lookup limit, because
it starts over in the same order. Email intake never replaces: a re-sent
invoice is ignored.

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
5. In the editor, select `processEpgInvoices` and click **Run** once. Google
   will ask you to authorize Gmail and external-request access. Check the
   execution log, then the Invoices page.
6. Select `installHourlyTrigger` and click **Run** once to schedule it.

### Labels

- `ShipLogger/Audited`: accepted (or already audited). Won't be sent again.
- `ShipLogger/Rejected`: ship_logger couldn't parse the attachment as an
  EPG invoice. Check the execution log, fix, then remove the label to retry.
- No label: not yet processed, or a transient failure that will be retried
  next hour.

Only emails from the last 60 days are picked up, so turning this on won't
import your whole invoice history. Upload older invoices by hand if you
want them.

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
