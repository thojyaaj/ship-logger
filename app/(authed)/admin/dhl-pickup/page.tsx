import { pageRequireAdmin } from "@/lib/auth";
import { getDhlPickupSettings } from "@/lib/dhl-pickup";
import DhlPickupSettingsClient from "./DhlPickupSettingsClient";

export default async function DhlPickupSettingsPage() {
  await pageRequireAdmin();
  const settings = await getDhlPickupSettings();
  return <DhlPickupSettingsClient initialSettings={settings} />;
}
