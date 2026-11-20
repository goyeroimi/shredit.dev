import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { getEnv } from "@/lib/config/env";
import { migrateDatabase } from "@/lib/database/migrate";

async function main() {
  const url = getEnv().DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required for db:migrate");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: url,
    max: 1,
    application_name: "shredit-migrate",
  });
  try {
    const migration = await readFile(
      path.join(process.cwd(), "drizzle", "0000_initial.sql"),
      "utf8",
    );
    const version = await migrateDatabase(pool, migration);
    console.log(`Shredit database schema is at version ${version}.`);
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error("Database migration failed.");
  process.exitCode = 1;
});
