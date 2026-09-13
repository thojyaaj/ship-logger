"use server";

import { requireSuperAdmin } from "@/lib/auth";
import { backfillDestinationCountries, type BackfillCountriesResult } from "@/lib/order-index";

// A "use server" file may only export async functions, so the extended
// function duration (one Shopify GraphQL call per distinct order — see
// MAX_ORDERS_PER_BACKFILL_RUN in lib/order-index.ts) is declared on
// admin/users/page.tsx instead, the route this action is invoked from.
//
// Superadmin-gated, not just admin — a bulk Shopify-data mutation tool
// most of this warehouse's admins never need to touch (see lib/auth.ts's
// requireSuperAdmin).
export async function backfillDestinationCountriesAction(): Promise<BackfillCountriesResult> {
  await requireSuperAdmin();
  return backfillDestinationCountries();
}
