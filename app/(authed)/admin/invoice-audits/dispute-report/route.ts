import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { buildDisputeReport } from "@/lib/invoice-audit/dispute-report";

/**
 * GET ?ids=<auditId>,<auditId>… — the carrier-facing dispute CSV for one or
 * more audits (see lib/invoice-audit/dispute-report.ts). A static segment,
 * so it takes precedence over the sibling [id] route.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (!user.isAdmin) return new NextResponse("Forbidden", { status: 403 });

  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-zA-Z-]{1,64}$/.test(s));
  if (ids.length === 0) return new NextResponse("Choose at least one invoice.", { status: 400 });

  const report = await buildDisputeReport(ids);
  if (!report) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(report.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report.fileName}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
