"use server";

import { requireAdmin } from "@/lib/auth";
import { generateBusinessInsights, type InsightsResult } from "@/lib/ai-insights";

// A "use server" file may only export async functions, so the extended
// function duration this action needs (a single, slow Anthropic call —
// longer than the default 10s Vercel Function duration) is declared on
// analytics/page.tsx instead, the route this action is invoked from.
export async function generateInsightsAction(windowDays: number, snapshot: unknown): Promise<InsightsResult> {
  await requireAdmin();
  return generateBusinessInsights(windowDays, snapshot);
}
