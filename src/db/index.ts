import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const DB_FILE = process.env.DATABASE_FILE ?? path.join(process.cwd(), "data", "math7.db");

let cached: Db | undefined;

export function getDb(): Db {
  if (cached) return cached;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const sqlite = new Database(DB_FILE);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  cached = drizzle(sqlite, { schema });
  return cached;
}

/** Raw handle — used by the migrator and by tests. */
export function getSqlite(file: string = DB_FILE): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

export { schema };
export type { Database as SqliteDatabase } from "better-sqlite3";
