"use server";

import { requireAdmin } from "@/lib/auth";
import { dismissProblem, undismissProblem, type ProblemCategory } from "@/lib/shipment-alerts";

// A "Dismiss selected" bulk action still exists in ExceptionsClient.tsx —
// it schedules the same per-row 10s countdown independently for every
// selected row (dismissProblemAction, one call per row once each countdown
// finishes) rather than one batched call, so cancelling one row never
// affects the rest. See its own comment for why that tradeoff is fine here.
export async function dismissProblemAction(scanId: string, category: ProblemCategory): Promise<void> {
  const admin = await requireAdmin();
  await dismissProblem(scanId, category, admin.id);
}

export async function undismissProblemAction(scanId: string, category: ProblemCategory): Promise<void> {
  await requireAdmin();
  await undismissProblem(scanId, category);
}
