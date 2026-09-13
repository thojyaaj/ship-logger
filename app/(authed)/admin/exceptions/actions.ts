"use server";

import { requireAdmin } from "@/lib/auth";
import { dismissProblem, dismissProblems, type ProblemCategory } from "@/lib/shipment-alerts";

export async function dismissProblemAction(scanId: string, category: ProblemCategory): Promise<void> {
  const admin = await requireAdmin();
  await dismissProblem(scanId, category, admin.id);
}

export async function dismissProblemsAction(items: { scanId: string; category: ProblemCategory }[]): Promise<void> {
  const admin = await requireAdmin();
  await dismissProblems(items, admin.id);
}
