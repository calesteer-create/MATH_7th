/**
 * Development fixture — NOT curriculum content.
 *
 * Creates one obviously-placeholder unit and one placeholder lesson so the
 * interface can be inspected before real textbook material exists. It never
 * writes mathematics, explanations or exercises.
 *
 *   node scripts/dev-fixture.cjs          create placeholders
 *   node scripts/dev-fixture.cjs --clear  remove them
 */
const D = require("better-sqlite3");
const db = new D(process.env.DATABASE_FILE ?? "data/math7.db");
const now = new Date().toISOString();

if (process.argv.includes("--clear")) {
  db.exec("DELETE FROM lesson_images WHERE lesson_id IN (SELECT id FROM lessons WHERE title_ar LIKE '%[تجريبي]%');");
  db.exec("DELETE FROM lessons WHERE title_ar LIKE '%[تجريبي]%';");
  db.exec("DELETE FROM units WHERE title_ar LIKE '%[تجريبي]%';");
  console.log("✓ removed development fixtures");
  process.exit(0);
}

const unit = db
  .prepare(
    "INSERT INTO units (position,title_ar,description_ar,page_from,page_to,accent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
  .run(99, "وحدة [تجريبي]", "عنصر نائب للتحقق من التصميم — لا يمثل أي وحدة في المنهاج", "", "", "sky", now, now);

db.prepare(
  "INSERT INTO lessons (unit_id,position,title_ar,page_label,status,content_updated_at,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?)",
).run(Number(unit.lastInsertRowid), 1, "درس [تجريبي]", "", now, now, now);

console.log("✓ created a placeholder unit and draft lesson (no curriculum content)");
