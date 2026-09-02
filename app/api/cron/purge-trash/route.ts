import { NextResponse } from "next/server";
import { runPurgeTrashCron } from "@/lib/purge-cron";
import { cronRequestIsAuthorized } from "@/lib/cron-auth";

export async function GET(req: Request) {
  if (!cronRequestIsAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await runPurgeTrashCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/purge-trash] failed:", err);
    return NextResponse.json({ ok: false, error: "Trash purge failed." }, { status: 500 });
  }
}
