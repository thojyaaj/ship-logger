import "server-only";

/**
 * Thin Resend wrapper for outbound admin alerts (lib/shipment-alerts.ts).
 * Same posture as every other optional external integration in this app
 * (DHL pickup, UPS/DHL tracking): without RESEND_API_KEY configured, this
 * no-ops with a clear log line rather than throwing — a missing API key
 * shouldn't take down the cron that also refreshes tracking statuses.
 */

const FROM = process.env.ALERT_FROM_EMAIL ?? "alerts@otcshoppeexpress.com";
const DEFAULT_TO = process.env.ALERT_TO_EMAILS ?? "otcshoppeexpress@gmail.com";

export async function sendAlertEmail(subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping alert email:", subject);
    return false;
  }

  const to = DEFAULT_TO.split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) {
    console.warn("[email] ALERT_TO_EMAILS resolved to no recipients — skipping:", subject);
    return false;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    console.error(`[email] Resend send failed: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}
