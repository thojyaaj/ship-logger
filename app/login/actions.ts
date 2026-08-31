"use server";

import { headers } from "next/headers";
import {
  checkRateLimit,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  findUserByPin,
  establishSession,
} from "@/lib/auth";

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "unknown";
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
