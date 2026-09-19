import "server-only";

/**
 * The deployed Apps Script web app that turns a dispute report into a Gmail
 * draft (scripts/apps-script/epg-invoice-intake.gs, doGet). Null until it's
 * set up — the "Create Gmail draft" buttons then show a setup hint instead.
 * Only a script.google.com URL is accepted, so a typo can't point admins'
 * clicks somewhere else.
 */
export function gmailDraftUrl(): string | null {
  const url = process.env.GMAIL_DISPUTE_DRAFT_URL?.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "script.google.com" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function gmailDraftLink(baseUrl: string, disputeId: string): string {
  const u = new URL(baseUrl);
  u.searchParams.set("dispute", disputeId);
  return u.toString();
}
