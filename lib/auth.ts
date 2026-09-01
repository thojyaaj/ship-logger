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

const DEV_FALLBACK_SECRET = "dev-only-insecure-secret-change-me";

/**
 * The session cookie is a self-contained bearer token signed with this value,
 * so anyone who knows the secret can mint a cookie for any userId — including
 * an admin's. The dev fallback below is a literal in a public repository, so
 * treating "SESSION_SECRET is unset" as merely a warning in production would
 * mean the whole app is authenticated by a publicly-known key.
 *
 * Fails closed instead: thrown lazily at request time (not module scope) so a
 * production *build*, which legitimately has no runtime env, still succeeds.
 */
function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is not set. Refusing to sign sessions with the public dev fallback — see .env.example.",
    );
  }
  return DEV_FALLBACK_SECRET;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

/**
 * A short digest of the user's current password hash, mixed into the session
 * signature. This is what makes a PIN reset actually revoke existing sessions:
 * the cookie is a self-contained 30-day bearer token with no server-side
 * record, so before this an admin resetting a compromised PIN changed nothing
 * for whoever already held the cookie — they kept access for the full 30 days.
 * Changing the PIN changes pinHash, which changes this tag, which invalidates
 * every signature minted against the old one.
 *
 * The tag is never written into the cookie; it's recomputed from the database
 * row at verification time, so it can't be replayed or forged independently.
 */
function credentialTag(pinHash: string): string {
  return crypto.createHash("sha256").update(pinHash).digest("hex").slice(0, 16);
}

function signSession(userId: string, expiresAt: string | number, tag: string): string {
  return sign(`${userId}.${expiresAt}.${tag}`);
}

function packCookie(userId: string, expiresAt: number, pinHash: string): string {
  return `${userId}.${expiresAt}.${signSession(userId, expiresAt, credentialTag(pinHash))}`;
}

/** Splits the cookie without verifying — the signature needs the DB row. */
function parseCookie(value: string): { userId: string; expiresAtStr: string; sig: string } | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, sig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { userId, expiresAtStr, sig };
}

function signatureMatches(sig: string, expected: string): boolean {
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  const parsed = parseCookie(raw);
  if (!parsed) return null;

  const rows = await db
    .select()
    .from(appUser)
    .where(eq(appUser.id, parsed.userId))
    .limit(1);
  const user = rows[0];
  if (!user || !user.active) return null;

  // Signature is verified against the row, so a PIN reset invalidates the
  // cookie. `active` and `isAdmin` are likewise re-read every request, so
  // deactivation and demotion already take effect immediately.
  const expected = signSession(parsed.userId, parsed.expiresAtStr, credentialTag(user.pinHash));
  if (!signatureMatches(parsed.sig, expected)) return null;

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
  const rows = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw new Error("Cannot establish a session for an unknown user.");

  const store = await cookies();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  store.set(SESSION_COOKIE, packCookie(userId, expiresAt, user.pinHash), {
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
  const tripsLockout = cumulativeFailures >= LOCKOUT_AFTER;

  attempts.set(ip, {
    windowCount: windowExpired ? 1 : entry.windowCount + 1,
    windowStart: windowExpired ? now : entry.windowStart,
    // Serving the lockout resets the counter. Without this, cumulativeFailures
    // stays >= LOCKOUT_AFTER forever, so every *subsequent* failure re-trips a
    // fresh 15-minute lock — one packer fat-fingering their PIN 10 times would
    // pin the warehouse's shared egress IP to one attempt per 15 minutes
    // indefinitely, since only a successful login clears the entry.
    cumulativeFailures: tripsLockout ? 0 : cumulativeFailures,
    lockedUntil: tripsLockout ? now + LOCKOUT_MS : (entry?.lockedUntil ?? 0),
  });
}

export function recordSuccessfulAttempt(ip: string): void {
  attempts.delete(ip);
}
