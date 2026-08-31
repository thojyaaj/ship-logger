import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index";
import path from "node:path";

async function main() {
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  console.log("Migrations applied.");
  process.exit(0);
}

main();
