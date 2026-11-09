/**
 * MATH 7TH — content model (single source of truth).
 *
 * The site is being migrated off SQLite onto plain JSON files in git, so the
 * content of the platform is reviewable in diffs, backed up by history, and
 * buildable into the static site with no server. This module defines the
 * shapes and invariants of that content. `validate.ts` enforces them; the
 * hand-written SQL migrations under src/db/ remain the source of truth for
 * the current server app until PR 4 removes them.
 *
 * Storage layout (see docs/CONTENT_MODEL.md):
 *
 *   content/units/<id>.json           one file per unit, filename is the id
 *   content/lessons/<id>.json         one file per lesson, filename is the id
 *   content/quizzes/lesson-<id>.json  at most one quiz per lesson
 *   content/quizzes/unit-<id>.json    at most one quiz per unit
 *   public/media/lessons/<id>/<file>          web-optimised WebP pages
 *   public/media/lessons/<id>/thumbs/<file>   thumbnails
 *
 * Nothing in here is textbook content. Example trees used for tests and docs
 * live under tests/content/example and are labelled as reference examples.
 */
import crypto from "node:crypto";
import { UNIT_ACCENTS, type UnitAccent } from "../lib/utils";

/* ── Units ─────────────────────────────────────────────────────────────── */

export interface UnitContent {
  id: number;
  position: number;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  pageFrom: string;
  pageTo: string;
  accent: UnitAccent;
  createdAt: string;
  updatedAt: string;
}

/* ── Lessons ───────────────────────────────────────────────────────────── */

export type LessonStatus = "draft" | "published";

export interface LessonImageContent {
  /** 1-based display order within the lesson. */
  position: number;
  /** Bare filename inside the lesson media folder, e.g. "page-01.webp". */
  file: string;
  /** Derived thumbnail path, always "thumbs/<file>". */
  thumb: string;
  width: number | null;
  height: number | null;
  /** Size of the original upload in bytes (informational). */
  bytes: number | null;
  /** sha256 of the stored WebP file — lowercase hex, 64 chars. */
  sha256: string;
}

export interface LessonContent {
  id: number;
  unitId: number;
  position: number;
  titleAr: string;
  titleEn: string;
  pageLabel: string;
  status: LessonStatus;
  isLastInUnit: boolean;
  publishedAt: string | null;
  contentUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
  images: LessonImageContent[];
}

/* ── Quizzes (future stages) ───────────────────────────────────────────── */

export type QuizScope = "lesson" | "unit";
export type QuizStatus =
  | "idle"
  | "generating"
  | "draft"
  | "published"
  | "stale"
  | "failed";
export type QuizVersionStatus = "draft" | "approved";
export type GradingMode = "auto_exact" | "auto_numeric" | "self_assessed";

export interface QuizQuestionContent {
  position: number;
  /** Free-form but non-empty; documented examples: mcq, numeric, essay. */
  type: string;
  promptAr: string;
  promptEn: string;
  /** Structured sub-items (choices, matching pairs, …) — model is open. */
  parts: unknown[];
  /** Machine-checkable answer payload; shape depends on `type`. */
  answer: Record<string, unknown>;
  explanationAr: string;
  explanationEn: string;
  points: number;
  gradingMode: GradingMode;
  /** Optional reference to an image `file` of the assessed lesson. */
  sourceImage: string | null;
  /** Free-form locator for the source passage, e.g. "page 3". */
  sourceRef: string;
  confidence: string;
  needsReview: boolean;
}

export interface QuizVersionContent {
  /** 1-based; unique within the quiz; doubles as the version identifier. */
  versionNumber: number;
  status: QuizVersionStatus;
  provider: string;
  model: string;
  notes: string;
  generatorLog: string[];
  createdAt: string;
  approvedAt: string | null;
  questions: QuizQuestionContent[];
}

export interface QuizContent {
  scope: QuizScope;
  lessonId: number | null;
  unitId: number | null;
  status: QuizStatus;
  /** versionNumber of the active version; null while idle/generating. */
  activeVersion: number | null;
  /**
   * Fingerprint of the assessed source images, as produced by
   * computeSourceFingerprint(). "" for never-generated quizzes. A mismatch
   * with the current images means the quiz is stale relative to its source.
   */
  sourceFingerprint: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  versions: QuizVersionContent[];
}

/* ── Formats & limits ──────────────────────────────────────────────────── */

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const SHA256_RE = /^[a-f0-9]{64}$/;
export const IMAGE_FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.webp$/;

export const LIMITS = {
  title: 200,
  description: 1000,
  pageLabel: 100,
  pageFromTo: 20,
  questionType: 50,
  sourceRef: 200,
  providerModel: 120,
  notes: 2000,
  generatorLogLines: 500,
  questionsPerVersion: 100,
} as const;

export const QUIZ_STATUSES: readonly QuizStatus[] = [
  "idle",
  "generating",
  "draft",
  "published",
  "stale",
  "failed",
];
export const GRADING_MODES: readonly GradingMode[] = [
  "auto_exact",
  "auto_numeric",
  "self_assessed",
];
export const LESSON_STATUSES: readonly LessonStatus[] = ["draft", "published"];

export { UNIT_ACCENTS, type UnitAccent };

/* ── Fingerprints ──────────────────────────────────────────────────────── */

/**
 * Content fingerprint of the image set an assessment was built from.
 * Sorted by position so reordering the array without changing the images does
 * not invalidate a quiz; adding/removing/replacing an image does.
 */
export function computeSourceFingerprint(
  images: ReadonlyArray<Pick<LessonImageContent, "sha256" | "position">>,
): string {
  if (images.length === 0) return "";
  const lines = [...images]
    .sort((a, b) => a.position - b.position)
    .map((image) => `${image.sha256}:${image.position}`);
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}
