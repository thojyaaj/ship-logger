import { pageRequireAdmin } from "@/lib/auth";
import { getDismissedProblems } from "@/lib/shipment-alerts";
import DismissedClient from "./DismissedClient";

export default async function DismissedProblemsPage() {
  await pageRequireAdmin();
  const items = await getDismissedProblems();
  return <DismissedClient items={items} />;
}
