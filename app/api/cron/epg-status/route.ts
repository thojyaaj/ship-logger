import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { runEpgStatusCron } from "@/lib/epg-cron";

// Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically when
// CRON_SECRET is set — see vercel.json. Locally, hit this with the same header
// to test manually. Missing CRON_SECRET in dev intentionally leaves this open.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const expected = `Bearer ${secret}`;
    const a = Buffer.from(auth);
    const b = Buffer.from(expected);
    // Constant-time compare — a plain !== leaks how many leading characters
    // matched via response timing, letting the secret be recovered byte by
    // byte over enough requests.
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!valid) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  try {
    const result = await runEpgStatusCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Non-fatal by design (§8.9) — this endpoint failing should never take
    // the rest of the app down. Report the failure, don't throw.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 200 },
    );
  }
}
