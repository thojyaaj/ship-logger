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
};

export async function listUsers(): Promise<UserListItem[]> {
  const rows = await db.select().from(appUser).orderBy(appUser.createdAt);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isAdmin: r.isAdmin,
    active: r.active,
    createdAt: r.createdAt,
  }));
}

export type UserMutationResult = { status: "ok" } | { status: "error"; message: string };

export async function addUser(name: string, pin: string): Promise<UserMutationResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { status: "error", message: "Name is required." };
  if (!/^\d{4}$/.test(pin)) return { status: "error", message: "PIN must be exactly 4 digits." };
  if (await pinIsTaken(pin)) {
    return { status: "error", message: "That PIN is already in use by another active user." };
  }

  await db.insert(appUser).values({
    id: newId(),
    name: trimmedName,
    pinHash: hashPin(pin),
    isAdmin: false,
    active: true,
  });
  return { status: "ok" };
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
