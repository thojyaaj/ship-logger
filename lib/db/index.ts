import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — see .env.example.");
}

// One client per module scope, reused across warm serverless invocations.
// `prepare: false` is required against Supabase's transaction pooler
// (pgbouncer in transaction mode doesn't support prepared statements) —
// harmless against a direct connection too, so it's left on unconditionally.
declare global {
  var __shiplogSql: ReturnType<typeof postgres> | undefined;
}

const client = global.__shiplogSql ?? postgres(connectionString, { prepare: false });

if (process.env.NODE_ENV !== "production") {
  global.__shiplogSql = client;
}

export const db = drizzle(client, { schema });
