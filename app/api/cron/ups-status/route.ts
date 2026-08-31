import { NextResponse } from "next/server";
import { runUpsStatusCron } from "@/lib/ups-cron";

// Same auth posture as app/api/cron/epg-status/route.ts — Vercel Cron sends
// `Authorization: Bearer ${CRON_SECRET}` automatically when CRON_SECRET is
// set (see vercel.json); missing it in dev intentionally leaves this open.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  try {
    const result = await runUpsStatusCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Non-fatal by design, same as the EPG cron — a failure here should
    // never take the rest of the app down.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 200 },
    );
  }
}
