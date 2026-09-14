"use server";

import { requireAdmin } from "@/lib/auth";
import { addUser, resetPin, setAdmin, setActive, type UserMutationResult } from "@/lib/users";

export async function addUserAction(name: string, pin: string): Promise<UserMutationResult> {
  await requireAdmin();
  return addUser(name, pin);
}

export async function resetPinAction(userId: string, pin: string): Promise<UserMutationResult> {
  const admin = await requireAdmin();
  return resetPin(admin, userId, pin);
}

export async function setAdminAction(userId: string, isAdmin: boolean): Promise<UserMutationResult> {
  const admin = await requireAdmin();
  if (userId === admin.id && !isAdmin) {
    return { status: "error", message: "You can't remove your own admin access." };
  }
  return setAdmin(admin, userId, isAdmin);
}

export async function setActiveAction(userId: string, active: boolean): Promise<UserMutationResult> {
  const admin = await requireAdmin();
  if (userId === admin.id && !active) {
    return { status: "error", message: "You can't deactivate your own account." };
  }
  return setActive(admin, userId, active);
}
