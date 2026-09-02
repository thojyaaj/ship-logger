import { pageRequireAdmin } from "@/lib/auth";
import { listTrashedShipments } from "@/lib/shiplog";
import TrashClient from "./TrashClient";

export default async function TrashPage() {
  await pageRequireAdmin();
  const shipments = await listTrashedShipments();
  return <TrashClient initialShipments={shipments} />;
}
