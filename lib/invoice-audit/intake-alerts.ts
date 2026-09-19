import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { invoiceAudit } from "../db/schema";
import { sendAlertEmail } from "../email";
import { parseDbTimestamp } from "../date";

/**
 * Alerts for the Gmail invoice intake failing quietly. Two ways it can:
 * 1. An invoice arrives but can't be read (EPG changed the spreadsheet) —
 *    the script labels it "Rejected" and moves on.
 * 2. Nothing arrives at all (the script's trigger stopped, its Google
 *    authorization lapsed, the secret was rotated on one side only).
 */

const APP_URL = "https://ship.otcshoppeexpress.com";

// EPG invoices arrive about weekly; two weeks with none is worth a look.
const QUIET_DAYS = 14;
// Repeat weekly while it stays quiet, rather than every night.
const REPEAT_EVERY_DAYS = 7;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function sendRejectedInvoiceAlert(fileName: string | null, messageId: string | null, reason: string): Promise<void> {
  try {
    await sendAlertEmail(
      `EPG invoice couldn't be read: ${fileName ?? "attachment"}`,
      `<p>An EPG invoice arrived from Gmail but ship_logger couldn't read it, so it was <strong>not audited</strong>.</p>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 8px">File</td><td style="padding:4px 8px;font-family:monospace">${escapeHtml(fileName ?? "—")}</td></tr>
<tr><td style="padding:4px 8px">Reason</td><td style="padding:4px 8px">${escapeHtml(reason)}</td></tr>
<tr><td style="padding:4px 8px">Gmail message</td><td style="padding:4px 8px;font-family:monospace">${escapeHtml(messageId ?? "—")}</td></tr>
</table>
<p>If EPG changed their spreadsheet layout, the parser needs updating. Meanwhile you can try uploading the file by hand on
<a href="${APP_URL}/admin/invoice-audits">the Invoices page</a>. The email is labeled <em>ShipLogger/Rejected</em> in Gmail.</p>`,
    );
  } catch (err) {
    // Never let the alert turn a clean 422 into a 500 the script would retry.
    console.error("[invoice-intake] rejected-invoice alert failed:", err);
  }
}

export type IntakeHealth = { lastEmailAuditAt: string | null; daysQuiet: number | null; alerted: boolean };

/**
 * Nightly check (from the invoice-recheck cron): alerts when no invoice has
 * come in from Gmail for QUIET_DAYS, then weekly while it stays quiet.
 * Silent until the first email-sourced audit exists, i.e. until the
 * intake is set up at all.
 */
export async function checkIntakeHealth(now: Date = new Date()): Promise<IntakeHealth> {
  const [last] = await db
    .select({ createdAt: invoiceAudit.createdAt })
    .from(invoiceAudit)
    .where(and(eq(invoiceAudit.carrier, "epg"), eq(invoiceAudit.source, "email")))
    .orderBy(desc(invoiceAudit.createdAt))
    .limit(1);
  if (!last) return { lastEmailAuditAt: null, daysQuiet: null, alerted: false };

  const daysQuiet = Math.floor((now.getTime() - parseDbTimestamp(last.createdAt).getTime()) / 86_400_000);
  const due = daysQuiet >= QUIET_DAYS && (daysQuiet - QUIET_DAYS) % REPEAT_EVERY_DAYS === 0;
  if (due) {
    await sendAlertEmail(
      `No EPG invoice received from Gmail in ${daysQuiet} days`,
      `<p>ship_logger hasn't received an EPG invoice from the Gmail automation in <strong>${daysQuiet} days</strong>
(last one ${escapeHtml(last.createdAt)} UTC).</p>
<p>If EPG has sent invoices since then, the Apps Script has probably stopped. In Apps Script, check:</p>
<ul>
<li><strong>Executions</strong>: are hourly runs happening, and do they show errors?</li>
<li><strong>Triggers</strong>: is <code>processEpgInvoices</code> still scheduled hourly?</li>
<li>Run <code>processEpgInvoices</code> by hand and read the first log line.</li>
</ul>
<p>If EPG simply hasn't invoiced, you can ignore this.</p>`,
    );
  }
  return { lastEmailAuditAt: last.createdAt, daysQuiet, alerted: due };
}
