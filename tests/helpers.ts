import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { getSqlite } from "@/db";
import { migrate } from "../scripts/migrate";

export interface TempDb {
  sqlite: Database.Database;
  file: string;
  close(): void;
}

export function createTempDb(): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-test-"));
  const file = path.join(dir, "test.db");
  const sqlite = getSqlite(file);
  migrate(sqlite);
  return {
    sqlite,
    file,
    close() {
      sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
