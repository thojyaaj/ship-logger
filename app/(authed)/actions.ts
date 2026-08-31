"use server";

import { clearSession } from "@/lib/auth";

export async function switchUser(): Promise<void> {
  await clearSession();
}
