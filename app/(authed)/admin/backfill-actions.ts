"use server";

import { requireAdmin } from "@/lib/auth";
import { backfillDestinationCountries, type BackfillCountriesResult } from "@/lib/order-index";

// A "use server" file may only export async functions, so the extended
// function duration (one Shopify GraphQL call per distinct order — see
// MAX_ORDERS_PER_BACKFILL_RUN in lib/order-index.ts) is declared on
// admin/users/page.tsx instead, the route this action is invoked from.
export async function backfillDestinationCountriesAction(): Promise<BackfillCountriesResult> {
  await requireAdmin();
  return backfillDestinationCountries();
}
