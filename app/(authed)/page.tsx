import { pageRequireUser } from "@/lib/auth";
import { getOrCreateOpenSession } from "@/lib/shiplog";
import ScanClient from "./ScanClient";

export default async function ScanPage() {
  const user = await pageRequireUser();
  const dashboard = await getOrCreateOpenSession(user.id);

  return <ScanClient initialDashboard={dashboard} currentUser={user} />;
}
