import { pageRequireUser } from "@/lib/auth";
import { getOpenSession, getRestorableReset } from "@/lib/shiplog";
import ScanClient from "./ScanClient";

export default async function ScanPage() {
  const user = await pageRequireUser();
  const [dashboard, restorableReset] = await Promise.all([getOpenSession(), getRestorableReset()]);

  return <ScanClient initialDashboard={dashboard} initialRestorableReset={restorableReset} currentUser={user} />;
}
