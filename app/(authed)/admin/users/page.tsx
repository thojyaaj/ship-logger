import { pageRequireAdmin } from "@/lib/auth";
import { listUsers } from "@/lib/users";
import { getDhlPickupSettings } from "@/lib/dhl-pickup";
import { getDisplaySettings } from "@/lib/display-settings";
import UsersClient from "./UsersClient";
import DhlPickupSettingsClient from "../dhl-pickup/DhlPickupSettingsClient";
import BackfillCountriesClient from "../BackfillCountriesClient";
import DisplaySettingsClient from "../DisplaySettingsClient";
import ClearPickupHistoryClient from "../dhl-pickup/ClearPickupHistoryClient";

// Matches the ShipStation/DHL cron routes' reasoning: BackfillCountriesClient's
// action can make up to 40 sequential Shopify calls (see
// MAX_ORDERS_PER_BACKFILL_RUN in lib/order-index.ts), longer than the
// default 10s Vercel Function duration allows.
export const maxDuration = 60;

// The single Admin destination — crew roster and DHL pickup settings used
// to be two separate nav-linked pages; this is "one place to set those
// settings" instead, each still its own self-contained client component,
// just sharing one page-level wrapper/heading now.
export default async function AdminPage() {
  const admin = await pageRequireAdmin();
  const [users, dhlSettings, displaySettings] = await Promise.all([
    listUsers(),
    getDhlPickupSettings(),
    getDisplaySettings(),
  ]);

  return (
    <div className="flex-1 flex flex-col gap-10 p-4 md:p-6 max-w-2xl mx-auto w-full">
      <h1 className="font-stencil text-2xl tracking-wide">Admin</h1>
      <UsersClient initialUsers={users} currentUserId={admin.id} />
      <DhlPickupSettingsClient initialSettings={dhlSettings} />
      <DisplaySettingsClient initialBoxesAsTabs={displaySettings.boxesAsTabs} />
      <BackfillCountriesClient />
      <ClearPickupHistoryClient />
    </div>
  );
}
