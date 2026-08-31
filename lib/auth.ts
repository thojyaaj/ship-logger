import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { appUser } from "./db/schema";
import { eq } from "drizzle-orm";

const SESSION_COOKIE = "shiplog_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — kiosk tablet stays signed in

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Phase 1 / local-dev fallback so `npm run dev` works with zero setup.
    // Set SESSION_SECRET in production so restarts don't invalidate every session.
    return "dev-only-insecure-secret-change-me";
  }
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

function packCookie(userId: string, expiresAt: number): string {
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

function unpackCookie(value: string): { userId: string; expiresAt: number } | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, sig] = parts;
  const payload = `${userId}.${expiresAtStr}`;
  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { userId, expiresAt };
}

export type SessionUser = {
  id: string;
  name: string;
  isAdmin: boolean;
};

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const unpacked = unpackCookie(raw);
  if (!unpacked) return null;

  const rows = await db
    .select()
    .from(appUser)
    .where(eq(appUser.id, unpacked.userId))
    .limit(1);
  const user = rows[0];
  if (!user || !user.active) return null;

  return { id: user.id, name: user.name, isAdmin: user.isAdmin };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) throw new Error("Admin access required.");
  return user;
}

/**
 * Page-level guards for Server Components. Middleware isn't used for this
 * because it defaults to the Edge runtime, which can't load better-sqlite3 or
 * bcryptjs — Node-only libraries. Every protected page/layout calls one of
 * these at the top instead.
 */
export async function pageRequireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function pageRequireAdmin(): Promise<SessionUser> {
  const user = await pageRequireUser();
  if (!user.isAdmin) redirect("/");
  return user;
}

export async function establishSession(userId: string): Promise<void> {
  const store = await cookies();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  store.set(SESSION_COOKIE, packCookie(userId, expiresAt), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export function hashPin(pin: string): string {
  return bcrypt.hashSync(pin, 10);
}

/**
 * PINs identify the user directly (no separate username), so logging in means
 * checking the entered PIN against every active user's hash. Fine at the
 * headcount this app is built for (§8.1) — a handful of packers, not hundreds.
 */
export async function findUserByPin(pin: string): Promise<SessionUser | null> {
  const users = await db.select().from(appUser).where(eq(appUser.active, true));
  for (const user of users) {
    if (bcrypt.compareSync(pin, user.pinHash)) {
      return { id: user.id, name: user.name, isAdmin: user.isAdmin };
    }
  }
  return null;
}

/** Used by the admin screen to reject a PIN already in use by another active user. */
export async function pinIsTaken(pin: string, excludeUserId?: string): Promise<boolean> {
  const users = await db.select().from(appUser).where(eq(appUser.active, true));
  for (const user of users) {
    if (user.id === excludeUserId) continue;
    if (bcrypt.compareSync(pin, user.pinHash)) return true;
  }
  return false;
}

// --- Login rate limiting (§8.1: 5/min per IP, lock out 15min after 10 failures) ---
// In-memory only — resets on redeploy/restart. Fine for a single-process warehouse
// kiosk deployment; would need a shared store (Redis/DB) behind a serverless
// multi-instance deployment.
//
// `windowCount`/`windowStart` and `cumulativeFailures` are deliberately separate
// counters. The 5/min check only ever calls recordFailedAttempt for attempts it
// already let through (see app/login/actions.ts), so a single counter that reset
// every time the rolling window elapsed could never climb past ~5 — the 15-minute
// lockout at 10 failures would never fire, no matter how long someone kept
// guessing at one failure per window. cumulativeFailures instead only resets on
// a successful login (or the lockout itself firing), so failures actually stack
// across windows.
type Attempt = {
  windowCount: number;
  windowStart: number;
  cumulativeFailures: number;
  lockedUntil: number;
};
const attempts = new Map<string, Attempt>();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 5;
const LOCKOUT_AFTER = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

export function checkRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - now };
  }
  if (now - entry.windowStart > WINDOW_MS) {
    return { allowed: true };
  }
  if (entry.windowCount >= MAX_PER_WINDOW) {
    return { allowed: false, retryAfterMs: WINDOW_MS - (now - entry.windowStart) };
  }
  return { allowed: true };
}

export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  const windowExpired = !entry || now - entry.windowStart > WINDOW_MS;

  const cumulativeFailures = (entry?.cumulativeFailures ?? 0) + 1;
  const lockedUntil = cumulativeFailures >= LOCKOUT_AFTER ? now + LOCKOUT_MS : (entry?.lockedUntil ?? 0);

  attempts.set(ip, {
    windowCount: windowExpired ? 1 : entry.windowCount + 1,
    windowStart: windowExpired ? now : entry.windowStart,
    cumulativeFailures,
    lockedUntil,
  });
}

export function recordSuccessfulAttempt(ip: string): void {
  attempts.delete(ip);
}
