import { pageRequireUser } from "@/lib/auth";
import { getOpenSession, getRestorableReset } from "@/lib/shiplog";
import ScanClient from "./ScanClient";

// recordScan's after() callback (lib/shiplog.ts) does a live ShipStation
// lookup — up to a 15s timeout — in the background once a scan's response
// has already gone out. Server Action timeouts default to the page's own
// maxDuration, so without this the platform default (as low as 10s) could
// cut that lookup off before it finishes. Same ceiling as the ShipStation
// cron routes (e.g. app/api/cron/shipstation-labels/route.ts).
export const maxDuration = 60;

export default async function ScanPage() {
  const user = await pageRequireUser();
  const [dashboard, restorableReset] = await Promise.all([getOpenSession(), getRestorableReset()]);

  return <ScanClient initialDashboard={dashboard} initialRestorableReset={restorableReset} currentUser={user} />;
}
