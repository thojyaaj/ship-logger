import { pageRequireAdmin } from "@/lib/auth";
import { getProblemShipments } from "@/lib/shipment-alerts";
import ExceptionsClient from "./ExceptionsClient";

export default async function ExceptionsPage() {
  await pageRequireAdmin();
  const { exceptions, stale, losses } = await getProblemShipments();
  return <ExceptionsClient exceptions={exceptions} stale={stale} losses={losses} />;
}
