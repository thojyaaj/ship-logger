import { pageRequireUser } from "@/lib/auth";
import { getOpenSession } from "@/lib/shiplog";
import ScanClient from "./ScanClient";

export default async function ScanPage() {
  const user = await pageRequireUser();
  const dashboard = await getOpenSession();

  return <ScanClient initialDashboard={dashboard} currentUser={user} />;
}
