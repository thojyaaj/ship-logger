import "server-only";
import { db } from "./db";
import { appUser } from "./db/schema";
import { eq } from "drizzle-orm";
import { newId } from "./id";
import { hashPin, pinIsTaken } from "./auth";

export type UserListItem = {
  id: string;
  name: string;
  isAdmin: boolean;
  active: boolean;
  createdAt: string;
  packerCode: string | null;
};

export async function listUsers(): Promise<UserListItem[]> {
  const rows = await db.select().from(appUser).orderBy(appUser.createdAt);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isAdmin: r.isAdmin,
    active: r.active,
    createdAt: r.createdAt,
    packerCode: r.packerCode,
  }));
}

export type UserMutationResult = { status: "ok" } | { status: "error"; message: string };

const POSTGRES_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === POSTGRES_UNIQUE_VIOLATION;
}

/**
 * Lowest unused "00"-"99" code — a compact, stable stand-in for a packer's
 * name (see appUser.packerCode in the schema) that's cheap enough to affix
 * to a session's short ID and actually read at a glance. Reused from a
 * deactivated user rather than growing unbounded, since a 2-digit code
 * space is small.
 */
async function nextPackerCode(): Promise<string> {
  const rows = await db.select({ packerCode: appUser.packerCode }).from(appUser);
  const used = new Set(rows.map((r) => r.packerCode).filter((c): c is string => c !== null));
  for (let n = 1; n <= 99; n++) {
    const code = String(n).padStart(2, "0");
    if (!used.has(code)) return code;
  }
  throw new Error("No packer codes left — all 99 are in use.");
}

export async function addUser(name: string, pin: string): Promise<UserMutationResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { status: "error", message: "Name is required." };
  if (!/^\d{4}$/.test(pin)) return { status: "error", message: "PIN must be exactly 4 digits." };
  if (await pinIsTaken(pin)) {
    return { status: "error", message: "That PIN is already in use by another active user." };
  }

  // Retried once: two admins adding a user at the same moment could both
  // compute the same "next" packer code before either commits, and the
  // column's unique constraint (migration 0009) rejects the loser — same
  // shape as createOpenSessionRow's retry-on-conflict in lib/shiplog.ts.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db.insert(appUser).values({
        id: newId(),
        name: trimmedName,
        pinHash: hashPin(pin),
        isAdmin: false,
        active: true,
        packerCode: await nextPackerCode(),
      });
      return { status: "ok" };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 1) throw err;
    }
  }
  throw new Error("unreachable");
}

export async function resetPin(userId: string, pin: string): Promise<UserMutationResult> {
  if (!/^\d{4}$/.test(pin)) return { status: "error", message: "PIN must be exactly 4 digits." };
  if (await pinIsTaken(pin, userId)) {
    return { status: "error", message: "That PIN is already in use by another active user." };
  }
  await db.update(appUser).set({ pinHash: hashPin(pin) }).where(eq(appUser.id, userId));
  return { status: "ok" };
}

export async function setAdmin(userId: string, isAdmin: boolean): Promise<void> {
  await db.update(appUser).set({ isAdmin }).where(eq(appUser.id, userId));
}

export async function setActive(userId: string, active: boolean): Promise<void> {
  // Deactivate, never delete — historical scans reference this user (§8.1).
  await db.update(appUser).set({ active }).where(eq(appUser.id, userId));
}
