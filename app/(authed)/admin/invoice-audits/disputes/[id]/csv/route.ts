import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { buildDisputeReport } from "@/lib/invoice-audit/dispute-report";

/** The carrier-facing dispute CSV for one dispute (see lib/invoice-audit/dispute-report.ts). */
export async function GET(_req: Request, ctx: RouteContext<"/admin/invoice-audits/disputes/[id]/csv">) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (!user.isAdmin) return new NextResponse("Forbidden", { status: 403 });

  const { id } = await ctx.params;
  const report = await buildDisputeReport(id);
  if (!report) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(report.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report.fileName}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
