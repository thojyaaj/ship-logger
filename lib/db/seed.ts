import { db } from "./index";
import { appUser } from "./schema";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

async function main() {
  const existing = await db.select().from(appUser).limit(1);
  if (existing.length > 0) {
    console.log("Users already exist — skipping seed.");
    return;
  }

  const adminPin = process.env.SEED_ADMIN_PIN ?? "1234";
  await db.insert(appUser).values({
    id: crypto.randomUUID(),
    name: "Admin",
    pinHash: bcrypt.hashSync(adminPin, 10),
    isAdmin: true,
    active: true,
  });

  console.log(`Seeded admin user with PIN ${adminPin} — change this in /admin/users.`);
}

main();
