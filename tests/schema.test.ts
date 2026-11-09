import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { createTempDb } from "./helpers";

const TABLES = [
  schema.units,
  schema.lessons,
  schema.lessonImages,
  schema.quizzes,
  schema.quizVersions,
  schema.quizQuestions,
  schema.generationJobs,
  schema.adminUsers,
  schema.settings,
];

describe("hand-written SQL migrations match the Drizzle schema", () => {
  const db = createTempDb();

  it("creates every table the ORM expects, with matching columns", () => {
    for (const table of TABLES) {
      const config = getTableConfig(table);
      const rows = db.sqlite.prepare(`PRAGMA table_info(${config.name})`).all() as Array<{
        name: string;
      }>;
      const actual = new Set(rows.map((r) => r.name));
      expect(actual.size, `table ${config.name} missing`).toBeGreaterThan(0);

      for (const column of config.columns) {
        expect(actual.has(column.name), `${config.name}.${column.name} missing from SQL`).toBe(true);
      }
      for (const name of actual) {
        const known = config.columns.some((c) => c.name === name);
        expect(known, `unexpected SQL column ${config.name}.${name}`).toBe(true);
      }
    }
    db.close();
  });
});

describe("curriculum integrity constraints", () => {
  it("allows only one lesson flagged as last per unit", () => {
    const db = createTempDb();
    const now = new Date().toISOString();
    db.sqlite
      .prepare(
        "INSERT INTO units (id, position, title_ar, created_at, updated_at) VALUES (1,1,'u',?,?)",
      )
      .run(now, now);
    const insert = db.sqlite.prepare(
      `INSERT INTO lessons (unit_id, position, title_ar, is_last_in_unit, content_updated_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(1, "a", 1, now, now, now);
    expect(() => insert.run(2, "b", 1, now, now, now)).toThrow();
    db.close();
  });

  it("cascades lesson deletion to its images", () => {
    const db = createTempDb();
    const now = new Date().toISOString();
    db.sqlite
      .prepare("INSERT INTO units (id, position, title_ar, created_at, updated_at) VALUES (1,1,'u',?,?)")
      .run(now, now);
    db.sqlite
      .prepare(
        "INSERT INTO lessons (id, unit_id, position, title_ar, content_updated_at, created_at, updated_at) VALUES (1,1,1,'l',?,?,?)",
      )
      .run(now, now, now);
    db.sqlite
      .prepare(
        "INSERT INTO lesson_images (lesson_id, position, storage_key, mime, sha256, created_at) VALUES (1,1,'k','image/jpeg','h',?)",
      )
      .run(now);
    db.sqlite.prepare("DELETE FROM lessons WHERE id = 1").run();
    const left = db.sqlite.prepare("SELECT COUNT(*) AS n FROM lesson_images").get() as { n: number };
    expect(left.n).toBe(0);
    db.close();
  });

  it("rejects an unknown lesson status", () => {
    const db = createTempDb();
    const now = new Date().toISOString();
    db.sqlite
      .prepare("INSERT INTO units (id, position, title_ar, created_at, updated_at) VALUES (1,1,'u',?,?)")
      .run(now, now);
    expect(() =>
      db.sqlite
        .prepare(
          "INSERT INTO lessons (unit_id, position, title_ar, status, content_updated_at, created_at, updated_at) VALUES (1,1,'l','archived',?,?,?)",
        )
        .run(now, now, now),
    ).toThrow();
    db.close();
  });
});
