import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const units = sqliteTable("units", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  position: integer("position").notNull(),
  titleAr: text("title_ar").notNull(),
  titleEn: text("title_en").notNull().default(""),
  descriptionAr: text("description_ar").notNull().default(""),
  descriptionEn: text("description_en").notNull().default(""),
  pageFrom: text("page_from").notNull().default(""),
  pageTo: text("page_to").notNull().default(""),
  accent: text("accent").notNull().default("teal"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lessons = sqliteTable(
  "lessons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    unitId: integer("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    titleAr: text("title_ar").notNull(),
    titleEn: text("title_en").notNull().default(""),
    pageLabel: text("page_label").notNull().default(""),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    isLastInUnit: integer("is_last_in_unit").notNull().default(0),
    publishedAt: text("published_at"),
    contentUpdatedAt: text("content_updated_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_lessons_unit").on(t.unitId, t.position),
    uniqueIndex("uq_lessons_last_per_unit")
      .on(t.unitId)
      .where(sql`${t.isLastInUnit} = 1`),
  ],
);

export const lessonImages = sqliteTable(
  "lesson_images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    storageKey: text("storage_key").notNull(),
    webKey: text("web_key"),
    thumbKey: text("thumb_key"),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    sha256: text("sha256").notNull(),
    state: text("state", { enum: ["ready", "failed"] }).notNull().default("ready"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_images_lesson").on(t.lessonId, t.position)],
);

export const quizzes = sqliteTable(
  "quizzes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope", { enum: ["lesson", "unit"] }).notNull(),
    lessonId: integer("lesson_id").references(() => lessons.id, { onDelete: "cascade" }),
    unitId: integer("unit_id").references(() => units.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["idle", "generating", "draft", "published", "stale", "failed"],
    })
      .notNull()
      .default("idle"),
    activeVersionId: integer("active_version_id"),
    sourceFingerprint: text("source_fingerprint").notNull().default(""),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_quiz_lesson").on(t.lessonId).where(sql`${t.lessonId} IS NOT NULL`),
    uniqueIndex("uq_quiz_unit").on(t.unitId).where(sql`${t.unitId} IS NOT NULL`),
  ],
);

export const quizVersions = sqliteTable(
  "quiz_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quizId: integer("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    status: text("status", { enum: ["draft", "approved"] }).notNull().default("draft"),
    provider: text("provider").notNull().default(""),
    model: text("model").notNull().default(""),
    generatorLog: text("generator_log").notNull().default("[]"),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    approvedAt: text("approved_at"),
  },
  (t) => [index("idx_versions_quiz").on(t.quizId, t.versionNumber)],
);

export const quizQuestions = sqliteTable(
  "quiz_questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quizVersionId: integer("quiz_version_id")
      .notNull()
      .references(() => quizVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    promptAr: text("prompt_ar").notNull(),
    promptEn: text("prompt_en").notNull().default(""),
    parts: text("parts").notNull().default("[]"),
    answer: text("answer").notNull().default("{}"),
    explanationAr: text("explanation_ar").notNull().default(""),
    explanationEn: text("explanation_en").notNull().default(""),
    points: integer("points").notNull().default(1),
    gradingMode: text("grading_mode", {
      enum: ["auto_exact", "auto_numeric", "self_assessed"],
    })
      .notNull()
      .default("auto_exact"),
    sourceImageId: integer("source_image_id").references(() => lessonImages.id, {
      onDelete: "set null",
    }),
    sourceRef: text("source_ref").notNull().default(""),
    confidence: text("confidence").notNull().default("unverified"),
    needsReview: integer("needs_review").notNull().default(1),
  },
  (t) => [index("idx_questions_version").on(t.quizVersionId, t.position)],
);

export const generationJobs = sqliteTable(
  "generation_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quizId: integer("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    state: text("state", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    stage: text("stage").notNull().default(""),
    provider: text("provider").notNull().default(""),
    error: text("error"),
    log: text("log").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("idx_jobs_quiz").on(t.quizId, t.id)],
);

export const adminUsers = sqliteTable("admin_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Unit = typeof units.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type LessonImage = typeof lessonImages.$inferSelect;
export type Quiz = typeof quizzes.$inferSelect;
export type QuizVersion = typeof quizVersions.$inferSelect;
export type QuizQuestion = typeof quizQuestions.$inferSelect;
