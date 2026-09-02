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

  const adminPin = process.env.SEED_ADMIN_PIN;
  if (!adminPin || adminPin === "1234") {
    throw new Error("SEED_ADMIN_PIN must be set to a non-default value before seeding.");
  }
  await db.insert(appUser).values({
    id: crypto.randomUUID(),
    name: "Thao",
    pinHash: bcrypt.hashSync(adminPin, 10),
    isAdmin: true,
    active: true,
  });

  console.log("Seeded the initial admin user.");
}

main().then(() => process.exit(0));
