-- MATH 7TH — initial schema
-- Hand-written SQL is the source of truth. src/db/schema.ts mirrors it, and
-- tests/schema.test.ts asserts the two agree, so they cannot drift.

PRAGMA foreign_keys = ON;

-- ── Curriculum ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  position       INTEGER NOT NULL,
  title_ar       TEXT    NOT NULL,
  title_en       TEXT    NOT NULL DEFAULT '',
  description_ar TEXT    NOT NULL DEFAULT '',
  description_en TEXT    NOT NULL DEFAULT '',
  page_from      TEXT    NOT NULL DEFAULT '',
  page_to        TEXT    NOT NULL DEFAULT '',
  accent         TEXT    NOT NULL DEFAULT 'teal',
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id            INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  title_ar           TEXT    NOT NULL,
  title_en           TEXT    NOT NULL DEFAULT '',
  page_label         TEXT    NOT NULL DEFAULT '',
  status             TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  -- Only one lesson per unit may be flagged as the last; this is what makes the
  -- unit "complete" and triggers unit-quiz generation. Enforced by the DB.
  is_last_in_unit    INTEGER NOT NULL DEFAULT 0 CHECK (is_last_in_unit IN (0,1)),
  published_at       TEXT,
  content_updated_at TEXT    NOT NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_unit ON lessons(unit_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lessons_last_per_unit ON lessons(unit_id) WHERE is_last_in_unit = 1;

CREATE TABLE IF NOT EXISTS lesson_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  storage_key TEXT    NOT NULL,
  web_key     TEXT,
  thumb_key   TEXT,
  mime        TEXT    NOT NULL,
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER,
  sha256      TEXT    NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','failed')),
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_lesson ON lesson_images(lesson_id, position);

-- ── Quizzes ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quizzes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope               TEXT    NOT NULL CHECK (scope IN ('lesson','unit')),
  lesson_id           INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
  unit_id             INTEGER REFERENCES units(id) ON DELETE CASCADE,
  status              TEXT    NOT NULL DEFAULT 'idle'
                      CHECK (status IN ('idle','generating','draft','published','stale','failed')),
  active_version_id   INTEGER,
  -- Hash of the source content. When the owner edits a lesson after its quiz was
  -- generated, this no longer matches and the quiz is flagged 'stale' instead of
  -- being silently replaced.
  source_fingerprint  TEXT    NOT NULL DEFAULT '',
  last_error          TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quiz_lesson ON quizzes(lesson_id) WHERE lesson_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_quiz_unit   ON quizzes(unit_id)   WHERE unit_id   IS NOT NULL;

CREATE TABLE IF NOT EXISTS quiz_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id        INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  provider       TEXT    NOT NULL DEFAULT '',
  model          TEXT    NOT NULL DEFAULT '',
  generator_log  TEXT    NOT NULL DEFAULT '[]',
  notes          TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL,
  approved_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_quiz ON quiz_versions(quiz_id, version_number);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_version_id INTEGER NOT NULL REFERENCES quiz_versions(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  type            TEXT    NOT NULL,
  prompt_ar       TEXT    NOT NULL,
  prompt_en       TEXT    NOT NULL DEFAULT '',
  parts           TEXT    NOT NULL DEFAULT '[]',
  answer          TEXT    NOT NULL DEFAULT '{}',
  explanation_ar  TEXT    NOT NULL DEFAULT '',
  explanation_en  TEXT    NOT NULL DEFAULT '',
  points          INTEGER NOT NULL DEFAULT 1,
  -- auto_exact / auto_numeric are machine-verifiable. self_assessed means the
  -- system does NOT claim to mark it: the student is shown the model answer and
  -- the rubric and marks themselves.
  grading_mode    TEXT    NOT NULL DEFAULT 'auto_exact'
                  CHECK (grading_mode IN ('auto_exact','auto_numeric','self_assessed')),
  source_image_id INTEGER REFERENCES lesson_images(id) ON DELETE SET NULL,
  source_ref      TEXT    NOT NULL DEFAULT '',
  confidence      TEXT    NOT NULL DEFAULT 'unverified',
  needs_review    INTEGER NOT NULL DEFAULT 1 CHECK (needs_review IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_questions_version ON quiz_questions(quiz_version_id, position);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  state       TEXT    NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
  stage       TEXT    NOT NULL DEFAULT '',
  provider    TEXT    NOT NULL DEFAULT '',
  error       TEXT,
  log         TEXT    NOT NULL DEFAULT '[]',
  created_at  TEXT    NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_quiz ON generation_jobs(quiz_id, id);

-- ── Owner account & settings ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  applied_at TEXT    NOT NULL
);
