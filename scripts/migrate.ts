import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./load-env";
import { getSqlite } from "../src/db";

loadEnv();

const MIGRATIONS_DIR = path.join(process.cwd(), "src", "db", "migrations");

export function migrate(sqlite: ReturnType<typeof getSqlite>, dir = MIGRATIONS_DIR): string[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    sqlite.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name),
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const run = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString());
    });
    run();
    newlyApplied.push(file);
  }
  return newlyApplied;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("migrate.ts")) {
  const sqlite = getSqlite();
  const applied = migrate(sqlite);
  console.log(applied.length ? `✓ applied: ${applied.join(", ")}` : "✓ database already up to date");
  sqlite.close();
}
