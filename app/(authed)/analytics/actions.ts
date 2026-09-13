"use server";

import { requireAdmin } from "@/lib/auth";
import { generateBusinessInsights, saveInsight, type InsightsResult } from "@/lib/ai-insights";

// A "use server" file may only export async functions, so the extended
// function duration this action needs (a single, slow Anthropic call —
// longer than the default 10s Vercel Function duration) is declared on
// analytics/page.tsx instead, the route this action is invoked from.
export async function generateInsightsAction(windowDays: number, snapshot: unknown): Promise<InsightsResult> {
  const admin = await requireAdmin();
  const result = await generateBusinessInsights(windowDays, snapshot);
  // Only a real generation is worth keeping — an API/auth failure has
  // nothing an admin would want to review later.
  if (result.status === "ok") await saveInsight(windowDays, result.text, admin.id);
  return result;
}
