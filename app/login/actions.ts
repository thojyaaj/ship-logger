"use server";

import { headers } from "next/headers";
import {
  checkRateLimit,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  findUserByPin,
  establishSession,
} from "@/lib/auth";

/**
 * The rate-limit bucket key. This must not be attacker-chosen: a client can
 * send its own `X-Forwarded-For`, and proxies *append* rather than replace, so
 * the leftmost entry is whatever the caller put there. Keying on it let anyone
 * mint a fresh bucket per request (`X-Forwarded-For: 1.2.3.<n>`) and walk the
 * whole 4-digit PIN space with neither the 5/min limit nor the lockout firing.
 *
 * `x-vercel-forwarded-for` is set by Vercel's edge and strips any client-sent
 * copy, so it's trustworthy here; `x-real-ip` likewise. Only if both are absent
 * do we fall back to XFF, and then to its *rightmost* entry — the one appended
 * by the nearest (trusted) proxy rather than the one the client supplied.
 */
async function clientIp(): Promise<string> {
  const h = await headers();
  const trusted = h.get("x-vercel-forwarded-for") ?? h.get("x-real-ip");
  if (trusted?.trim()) return trusted.trim();

  const chain = h.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return chain?.length ? chain[chain.length - 1] : "unknown";
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function loginWithPin(pin: string): Promise<LoginResult> {
  if (!/^\d{4}$/.test(pin)) {
    return { ok: false, error: "PIN must be 4 digits." };
  }

  const ip = await clientIp();
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    const seconds = Math.ceil((rate.retryAfterMs ?? 0) / 1000);
    return { ok: false, error: `Too many attempts. Try again in ${seconds}s.` };
  }

  const user = await findUserByPin(pin);
  if (!user) {
    recordFailedAttempt(ip);
    return { ok: false, error: "PIN not recognized." };
  }

  recordSuccessfulAttempt(ip);
  await establishSession(user.id);
  return { ok: true };
}
