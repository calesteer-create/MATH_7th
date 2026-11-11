/**
 * Validators for the MATH 7TH content tree.
 *
 * Dependency-free on purpose (same philosophy as scripts/guard.mjs): every
 * rule below is enforced both in CI and before any publish, so a malformed
 * unit/lesson/quiz can never reach the built site — or the public repo.
 *
 * Each issue carries a stable `code` (grep-able, asserted in tests) and a
 * human `message`. `path` points at the offending file and, when known, at
 * the JSON pointer inside it.
 *
 * Severity: `error` fails validation; `warning` is reported but does not.
 * Warnings exist for things a human should review, never for broken data.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openDir, openDirUnder, readFileAt } from "../lib/dirfd";
import {
  GRADING_MODES,
  IMAGE_FILE_RE,
  ISO_DATE_RE,
  LESSON_STATUSES,
  LIMITS,
  QUIZ_STATUSES,
  SHA256_RE,
  UNIT_ACCENTS,
  computeSourceFingerprint,
  type LessonContent,
  type LessonImageContent,
  type QuizContent,
  type UnitContent,
} from "./model";

export interface ContentIssue {
  code: string;
  path: string;
  message: string;
}

export interface ContentStats {
  units: number;
  lessons: number;
  publishedLessons: number;
  draftLessons: number;
  images: number;
  quizzes: number;
  mediaBytes: number;
}

export interface TreeValidation {
  errors: ContentIssue[];
  warnings: ContentIssue[];
  stats: ContentStats;
}

const EMPTY_STATS: ContentStats = {
  units: 0,
  lessons: 0,
  publishedLessons: 0,
  draftLessons: 0,
  images: 0,
  quizzes: 0,
  mediaBytes: 0,
};

/* ── small helpers ─────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(
  obj: Record<string, unknown>,
  key: string,
  issue: (code: string, path: string, message: string) => void,
  opts: { max: number; allowEmpty: boolean; here: string },
): string | null {
  const value = obj[key];
  if (value === undefined) {
    issue("MISSING_FIELD", `${opts.here}/${key}`, `missing required field "${key}"`);
    return null;
  }
  if (typeof value !== "string") {
    issue("INVALID_TYPE", `${opts.here}/${key}`, `field "${key}" must be a string`);
    return null;
  }
  const trimmed = value.trim();
  if (!opts.allowEmpty && trimmed.length === 0) {
    issue("MISSING_FIELD", `${opts.here}/${key}`, `field "${key}" must not be empty`);
    return null;
  }
  if (trimmed.length > opts.max) {
    issue("STRING_TOO_LONG", `${opts.here}/${key}`, `field "${key}" exceeds ${opts.max} characters`);
    return null;
  }
  return trimmed;
}

function strOrEmpty(
  obj: Record<string, unknown>,
  key: string,
  issue: (code: string, path: string, message: string) => void,
  opts: { max: number; here: string },
): string {
  const value = obj[key];
  if (value === undefined) return "";
  if (typeof value !== "string") {
    issue("INVALID_TYPE", `${opts.here}/${key}`, `field "${key}" must be a string`);
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length > opts.max) {
    issue("STRING_TOO_LONG", `${opts.here}/${key}`, `field "${key}" exceeds ${opts.max} characters`);
  }
  return trimmed;
}

function int(
  obj: Record<string, unknown>,
  key: string,
  issue: (code: string, path: string, message: string) => void,
  opts: { min: number; here: string },
): number | null {
  const value = obj[key];
  if (value === undefined) {
    issue("MISSING_FIELD", `${opts.here}/${key}`, `missing required field "${key}"`);
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issue("INVALID_TYPE", `${opts.here}/${key}`, `field "${key}" must be an integer`);
    return null;
  }
  if (value < opts.min) {
    issue("INVALID_NUMBER", `${opts.here}/${key}`, `field "${key}" must be >= ${opts.min}`);
    return null;
  }
  return value;
}

function isoDate(
  value: unknown,
  here: string,
  issue: (code: string, path: string, message: string) => void,
  { allowNull }: { allowNull: boolean },
): string | null {
  if (value === null) {
    if (allowNull) return null;
    issue("MISSING_FIELD", here, "must be an ISO timestamp, not null");
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    issue("INVALID_ISO_DATE", here, `expected ISO-8601 UTC timestamp, got ${JSON.stringify(value)}`);
    return null;
  }
  return value;
}

function unknownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  here: string,
  issue: (code: string, path: string, message: string) => void,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issue("UNKNOWN_FIELD", `${here}/${key}`, `unknown field "${key}"`);
    }
  }
}

const CANONICAL_ID_RE = /^[1-9]\d{0,8}$/;
const LOOSE_ID_RE = /^\d{1,9}$/;

/**
 * Filenames are canonical: a positive integer without leading zeros
 * ("1.json", never "01.json"). Returns null for names that do not look like a
 * number at all (caller reports FILE_ID_MISMATCH); flags non-canonical numeric
 * names via `canonical: false` (caller reports FILENAME_NOT_CANONICAL) so the
 * problem is surfaced loudly instead of silently aliasing the same id.
 */
function parseFileId(name: string): { id: number; canonical: boolean } | null {
  const base = name.replace(/\.json$/i, "");
  if (!LOOSE_ID_RE.test(base)) return null;
  const id = Number(base);
  if (!Number.isInteger(id) || id < 1) return null;
  return { id, canonical: CANONICAL_ID_RE.test(base) };
}

/* ── per-file validators ───────────────────────────────────────────────── */

export function validateUnit(
  raw: unknown,
  fileLabel: string,
): { value: UnitContent | null; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  const issue = (code: string, path: string, message: string) =>
    issues.push({ code, path: `${fileLabel}#/${path}`.replace(/\/$/, ""), message });
  if (!isRecord(raw)) {
    issue("INVALID_TYPE", "", "unit file must contain a JSON object");
    return { value: null, issues };
  }
  const here = "";
  unknownFields(
    raw,
    [
      "id",
      "position",
      "titleAr",
      "titleEn",
      "descriptionAr",
      "descriptionEn",
      "pageFrom",
      "pageTo",
      "accent",
      "createdAt",
      "updatedAt",
    ],
    here,
    issue,
  );
  const id = int(raw, "id", issue, { min: 1, here });
  const position = int(raw, "position", issue, { min: 1, here });
  const titleAr = str(raw, "titleAr", issue, { max: LIMITS.title, allowEmpty: false, here });
  const titleEn = strOrEmpty(raw, "titleEn", issue, { max: LIMITS.title, here });
  const descriptionAr = strOrEmpty(raw, "descriptionAr", issue, { max: LIMITS.description, here });
  const descriptionEn = strOrEmpty(raw, "descriptionEn", issue, { max: LIMITS.description, here });
  const pageFrom = strOrEmpty(raw, "pageFrom", issue, { max: LIMITS.pageFromTo, here });
  const pageTo = strOrEmpty(raw, "pageTo", issue, { max: LIMITS.pageFromTo, here });
  const accentRaw = raw["accent"] === undefined ? "teal" : raw["accent"];
  if (typeof accentRaw !== "string" || !(UNIT_ACCENTS as readonly string[]).includes(accentRaw)) {
    issue("ACCENT_UNKNOWN", "/accent", `accent must be one of ${UNIT_ACCENTS.join(", ")}`);
  }
  const createdAt = isoDate(raw["createdAt"], "/createdAt", issue, { allowNull: false });
  const updatedAt = isoDate(raw["updatedAt"], "/updatedAt", issue, { allowNull: false });

  if (id === null || position === null || titleAr === null || createdAt === null || updatedAt === null) {
    return { value: null, issues };
  }
  return {
    value: {
      id,
      position,
      titleAr,
      titleEn,
      descriptionAr,
      descriptionEn,
      pageFrom,
      pageTo,
      accent: (UNIT_ACCENTS as readonly string[]).includes(accentRaw as string)
        ? (accentRaw as UnitContent["accent"])
        : "teal",
      createdAt,
      updatedAt,
    },
    issues,
  };
}

export function validateLesson(
  raw: unknown,
  fileLabel: string,
): { value: LessonContent | null; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  const issue = (code: string, path: string, message: string) =>
    issues.push({ code, path: `${fileLabel}#/${path}`.replace(/\/$/, ""), message });
  if (!isRecord(raw)) {
    issue("INVALID_TYPE", "", "lesson file must contain a JSON object");
    return { value: null, issues };
  }
  const here = "";
  unknownFields(
    raw,
    [
      "id",
      "unitId",
      "position",
      "titleAr",
      "titleEn",
      "pageLabel",
      "status",
      "isLastInUnit",
      "publishedAt",
      "contentUpdatedAt",
      "createdAt",
      "updatedAt",
      "images",
    ],
    here,
    issue,
  );
  const id = int(raw, "id", issue, { min: 1, here });
  const unitId = int(raw, "unitId", issue, { min: 1, here });
  const position = int(raw, "position", issue, { min: 1, here });
  const titleAr = str(raw, "titleAr", issue, { max: LIMITS.title, allowEmpty: false, here });
  const titleEn = strOrEmpty(raw, "titleEn", issue, { max: LIMITS.title, here });
  const pageLabel = strOrEmpty(raw, "pageLabel", issue, { max: LIMITS.pageLabel, here });

  const status = raw["status"];
  if (typeof status !== "string" || !(LESSON_STATUSES as readonly string[]).includes(status)) {
    issue("STATUS_INVALID", "/status", `status must be one of ${LESSON_STATUSES.join(", ")}`);
  }
  const isLast = raw["isLastInUnit"];
  if (typeof isLast !== "boolean") {
    issue("INVALID_TYPE", "/isLastInUnit", "isLastInUnit must be a boolean");
  }
  const publishedAt = isoDate(raw["publishedAt"], "/publishedAt", issue, { allowNull: true });
  const contentUpdatedAt = isoDate(raw["contentUpdatedAt"], "/contentUpdatedAt", issue, {
    allowNull: false,
  });
  const createdAt = isoDate(raw["createdAt"], "/createdAt", issue, { allowNull: false });
  const updatedAt = isoDate(raw["updatedAt"], "/updatedAt", issue, { allowNull: false });

  if (status === "published" && publishedAt === null) {
    issue("PUBLISHED_NEEDS_PUBLISHED_AT", "/publishedAt", "a published lesson must carry publishedAt");
  }

  const imagesRaw = raw["images"];
  const images: LessonImageContent[] = [];
  if (!Array.isArray(imagesRaw)) {
    issue("MISSING_FIELD", "/images", 'missing required field "images" (use [] for none)');
  } else {
    imagesRaw.forEach((entry, index) => {
      const imageIssues: ContentIssue[] = [];
      const imageIssue = (code: string, path: string, message: string) =>
        imageIssues.push({ code, path: `/images/${index}${path}`.replace(/\/$/, ""), message });
      const image = validateLessonImage(entry, imageIssue);
      for (const mapped of imageIssues) {
        issues.push({ code: mapped.code, path: mapped.path, message: mapped.message });
      }
      if (image) images.push(image);
    });
    const seenPositions = new Set<number>();
    for (const image of images) {
      if (seenPositions.has(image.position)) {
        issue("IMAGE_POSITION_DUPLICATE", "/images", `duplicate image position ${image.position}`);
      }
      seenPositions.add(image.position);
    }
  }

  if (status === "published" && images.length === 0) {
    issue("PUBLISHED_NEEDS_IMAGES", "/images", "a published lesson must have at least one image");
  }

  if (
    id === null ||
    unitId === null ||
    position === null ||
    titleAr === null ||
    contentUpdatedAt === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      id,
      unitId,
      position,
      titleAr,
      titleEn,
      pageLabel,
      status: (status as LessonContent["status"]) ?? "draft",
      isLastInUnit: isLast === true,
      publishedAt,
      contentUpdatedAt,
      createdAt,
      updatedAt,
      images,
    },
    issues,
  };
}

function validateLessonImage(
  raw: unknown,
  issue: (code: string, path: string, message: string) => void,
): LessonImageContent | null {
  if (!isRecord(raw)) {
    issue("INVALID_TYPE", "", "image entry must be a JSON object");
    return null;
  }
  unknownFields(raw, ["position", "file", "thumb", "width", "height", "bytes", "sha256"], "", issue);
  const position = int(raw, "position", issue, { min: 1, here: "" });

  const file = raw["file"];
  if (typeof file !== "string" || !IMAGE_FILE_RE.test(file)) {
    // The CMS stores the asset's public path (`/media/lessons/3/page-01.webp`)
    // while the model requires a bare name. That is reconciled by
    // `npm run media:sync` (src/media/naming.ts#canonicalMediaFile), not here —
    // the validator stays strict so an unexpected shape is never silently
    // accepted. Point the reader at the repair, not just the rule.
    const looksLikePath = typeof file === "string" && file.includes("/");
    issue(
      "IMAGE_FILE_INVALID",
      "/file",
      `file must match ${IMAGE_FILE_RE} (bare lowercase webp name, no directories)` +
        (looksLikePath
          ? ` — got ${JSON.stringify(file)}; run \`npm run media:sync\` to canonicalise CMS-written paths`
          : ""),
    );
  }
  const thumb = raw["thumb"];
  const expectedThumb = typeof file === "string" ? `thumbs/${file}` : null;
  if (thumb !== expectedThumb) {
    issue(
      "IMAGE_THUMB_MISMATCH",
      "/thumb",
      `thumb must be "thumbs/<file>" (expected ${JSON.stringify(expectedThumb)})`,
    );
  }
  const width = dim(raw["width"], "/width", issue);
  const height = dim(raw["height"], "/height", issue);
  const bytes = dim(raw["bytes"], "/bytes", issue);
  const sha256 = raw["sha256"];
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    issue("IMAGE_SHA256_INVALID", "/sha256", "sha256 must be 64 lowercase hex characters");
  }
  if (position === null || typeof file !== "string" || typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    return null;
  }
  return {
    position,
    file,
    thumb: `thumbs/${file}`,
    width,
    height,
    bytes,
    sha256,
  };
}

function dim(
  value: unknown,
  here: string,
  issue: (code: string, path: string, message: string) => void,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000) {
    issue("INVALID_NUMBER", here, "must be an integer between 1 and 100000 (or null)");
    return null;
  }
  return value;
}

export function validateQuiz(
  raw: unknown,
  fileLabel: string,
): { value: QuizContent | null; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  const issue = (code: string, path: string, message: string) =>
    issues.push({ code, path: `${fileLabel}#/${path}`.replace(/\/$/, ""), message });
  if (!isRecord(raw)) {
    issue("INVALID_TYPE", "", "quiz file must contain a JSON object");
    return { value: null, issues };
  }
  const here = "";
  unknownFields(
    raw,
    [
      "scope",
      "lessonId",
      "unitId",
      "status",
      "activeVersion",
      "sourceFingerprint",
      "lastError",
      "createdAt",
      "updatedAt",
      "versions",
    ],
    here,
    issue,
  );
  const scope = raw["scope"];
  if (scope !== "lesson" && scope !== "unit") {
    issue("QUIZ_SCOPE_INVALID", "/scope", 'scope must be "lesson" or "unit"');
  }
  const lessonId = nullableInt(raw["lessonId"], "/lessonId", issue);
  const unitId = nullableInt(raw["unitId"], "/unitId", issue);
  if (scope === "lesson") {
    if (lessonId === null || unitId !== null) {
      issue("QUIZ_TARGET_INVALID", "", 'a lesson-scope quiz must set lessonId and leave unitId null');
    }
  } else if (scope === "unit") {
    if (unitId === null || lessonId !== null) {
      issue("QUIZ_TARGET_INVALID", "", 'a unit-scope quiz must set unitId and leave lessonId null');
    }
  }

  const status = raw["status"];
  if (typeof status !== "string" || !(QUIZ_STATUSES as readonly string[]).includes(status)) {
    issue("STATUS_INVALID", "/status", `status must be one of ${QUIZ_STATUSES.join(", ")}`);
  }
  const activeVersion = nullableInt(raw["activeVersion"], "/activeVersion", issue, 1);
  const fingerprint = raw["sourceFingerprint"];
  if (
    typeof fingerprint !== "string" ||
    (fingerprint !== "" && !SHA256_RE.test(fingerprint))
  ) {
    issue("QUIZ_FINGERPRINT_INVALID", "/sourceFingerprint", "must be \"\" or 64 lowercase hex characters");
  }
  const lastError = raw["lastError"];
  if (lastError !== null && lastError !== undefined && typeof lastError !== "string") {
    issue("INVALID_TYPE", "/lastError", "lastError must be a string or null");
  }
  const createdAt = isoDate(raw["createdAt"], "/createdAt", issue, { allowNull: false });
  const updatedAt = isoDate(raw["updatedAt"], "/updatedAt", issue, { allowNull: false });

  const versionsRaw = raw["versions"];
  const versions: QuizContent["versions"] = [];
  if (!Array.isArray(versionsRaw)) {
    issue("MISSING_FIELD", "/versions", 'missing required field "versions" (use [])');
  } else {
    versionsRaw.forEach((entry, index) => {
      const version = validateQuizVersion(entry, `/versions/${index}`, issue);
      if (version) versions.push(version);
    });
    const seenVersions = new Set<number>();
    for (const version of versions) {
      if (seenVersions.has(version.versionNumber)) {
        issue("QUIZ_VERSION_DUPLICATE", "/versions", `duplicate versionNumber ${version.versionNumber}`);
      }
      seenVersions.add(version.versionNumber);
    }
  }
  if (activeVersion !== null && !versions.some((v) => v.versionNumber === activeVersion)) {
    issue(
      "QUIZ_ACTIVE_VERSION_INVALID",
      "/activeVersion",
      `activeVersion ${activeVersion} does not match any versionNumber`,
    );
  }
  if (createdAt === null || updatedAt === null) {
    return { value: null, issues };
  }
  return {
    value: {
      scope: (scope as QuizContent["scope"]) ?? "lesson",
      lessonId,
      unitId,
      status: (status as QuizContent["status"]) ?? "idle",
      activeVersion,
      sourceFingerprint: typeof fingerprint === "string" ? fingerprint : "",
      lastError: typeof lastError === "string" ? lastError.trim() : null,
      createdAt,
      updatedAt,
      versions,
    },
    issues,
  };
}

function nullableInt(
  value: unknown,
  here: string,
  issue: (code: string, path: string, message: string) => void,
  min = 1,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    issue("INVALID_NUMBER", here, `must be an integer >= ${min} (or null)`);
    return null;
  }
  return value;
}

function validateQuizVersion(
  raw: unknown,
  here: string,
  issue: (code: string, path: string, message: string) => void,
): QuizContent["versions"][number] | null {
  if (!isRecord(raw)) {
    issue("INVALID_TYPE", here, "version entry must be a JSON object");
    return null;
  }
  unknownFields(
    raw,
    [
      "versionNumber",
      "status",
      "provider",
      "model",
      "notes",
      "generatorLog",
      "createdAt",
      "approvedAt",
      "questions",
    ],
    here,
    issue,
  );
  const versionNumber = int(raw, "versionNumber", issue, { min: 1, here });
  const status = raw["status"];
  if (status !== "draft" && status !== "approved") {
    issue("STATUS_INVALID", `${here}/status`, 'version status must be "draft" or "approved"');
  }
  const provider = strOrEmpty(raw, "provider", issue, { max: LIMITS.providerModel, here });
  const model = strOrEmpty(raw, "model", issue, { max: LIMITS.providerModel, here });
  const notes = strOrEmpty(raw, "notes", issue, { max: LIMITS.notes, here });
  const generatorLog = raw["generatorLog"];
  const log: string[] = [];
  if (generatorLog !== undefined) {
    if (!Array.isArray(generatorLog) || generatorLog.length > LIMITS.generatorLogLines) {
      issue("INVALID_TYPE", `${here}/generatorLog`, `generatorLog must be an array of <= ${LIMITS.generatorLogLines} lines`);
    } else {
      for (const line of generatorLog) {
        if (typeof line !== "string") {
          issue("INVALID_TYPE", `${here}/generatorLog`, "generatorLog lines must be strings");
          break;
        }
        log.push(line);
      }
    }
  }
  const createdAt = isoDate(raw["createdAt"], `${here}/createdAt`, issue, { allowNull: false });
  const approvedAt = isoDate(raw["approvedAt"], `${here}/approvedAt`, issue, { allowNull: true });

  const questionsRaw = raw["questions"];
  const questions: QuizContent["versions"][number]["questions"] = [];
  if (!Array.isArray(questionsRaw)) {
    issue("MISSING_FIELD", `${here}/questions`, 'missing required field "questions" (use [])');
  } else {
    if (questionsRaw.length > LIMITS.questionsPerVersion) {
      issue("STRING_TOO_LONG", `${here}/questions`, `a version may hold at most ${LIMITS.questionsPerVersion} questions`);
    }
    questionsRaw.forEach((entry, index) => {
      const question = validateQuizQuestion(entry, `${here}/questions/${index}`, issue);
      if (question) questions.push(question);
    });
    const seenPositions = new Set<number>();
    for (const question of questions) {
      if (seenPositions.has(question.position)) {
        issue("QUIZ_QUESTION_POSITION_DUPLICATE", `${here}/questions`, `duplicate question position ${question.position}`);
      }
      seenPositions.add(question.position);
    }
  }
  if (versionNumber === null || createdAt === null) {
    return null;
  }
  return {
    versionNumber,
    status: status === "approved" ? "approved" : "draft",
    provider,
    model,
    notes,
    generatorLog: log,
    createdAt,
    approvedAt,
    questions,
  };
}

function validateQuizQuestion(
  raw: unknown,
  here: string,
  issue: (code: string, path: string, message: string) => void,
): QuizContent["versions"][number]["questions"][number] | null {
  if (!isRecord(raw)) {
    issue("INVALID_TYPE", here, "question entry must be a JSON object");
    return null;
  }
  unknownFields(
    raw,
    [
      "position",
      "type",
      "promptAr",
      "promptEn",
      "parts",
      "answer",
      "explanationAr",
      "explanationEn",
      "points",
      "gradingMode",
      "sourceImage",
      "sourceRef",
      "confidence",
      "needsReview",
    ],
    here,
    issue,
  );
  const position = int(raw, "position", issue, { min: 1, here });
  const type = str(raw, "type", issue, { max: LIMITS.questionType, allowEmpty: false, here });
  const promptAr = str(raw, "promptAr", issue, { max: 2000, allowEmpty: false, here });
  const promptEn = strOrEmpty(raw, "promptEn", issue, { max: 2000, here });
  const parts = raw["parts"];
  if (!Array.isArray(parts)) {
    issue("INVALID_TYPE", `${here}/parts`, "parts must be an array (use [] for none)");
  }
  const answer = raw["answer"];
  if (!isRecord(answer)) {
    issue("INVALID_TYPE", `${here}/answer`, "answer must be a JSON object");
  }
  const explanationAr = strOrEmpty(raw, "explanationAr", issue, { max: 4000, here });
  const explanationEn = strOrEmpty(raw, "explanationEn", issue, { max: 4000, here });
  const points = int(raw, "points", issue, { min: 1, here });
  const gradingMode = raw["gradingMode"];
  if (typeof gradingMode !== "string" || !(GRADING_MODES as readonly string[]).includes(gradingMode)) {
    issue("GRADING_MODE_INVALID", `${here}/gradingMode`, `gradingMode must be one of ${GRADING_MODES.join(", ")}`);
  }
  const sourceImage = raw["sourceImage"];
  if (sourceImage !== null && sourceImage !== undefined) {
    if (typeof sourceImage !== "string" || !IMAGE_FILE_RE.test(sourceImage)) {
      issue("IMAGE_FILE_INVALID", `${here}/sourceImage`, "sourceImage must be null or a valid webp file name");
    }
  }
  const sourceRef = strOrEmpty(raw, "sourceRef", issue, { max: LIMITS.sourceRef, here });
  const confidence = strOrEmpty(raw, "confidence", issue, { max: 40, here }) || "unverified";
  const needsReview = raw["needsReview"] === undefined ? true : raw["needsReview"];
  if (typeof needsReview !== "boolean") {
    issue("INVALID_TYPE", `${here}/needsReview`, "needsReview must be a boolean");
  }
  if (position === null || type === null || promptAr === null || points === null) {
    return null;
  }
  return {
    position,
    type,
    promptAr,
    promptEn,
    parts: Array.isArray(parts) ? parts : [],
    answer: isRecord(answer) ? answer : {},
    explanationAr,
    explanationEn,
    points,
    gradingMode: (gradingMode as QuizContent["versions"][number]["questions"][number]["gradingMode"]) ?? "auto_exact",
    sourceImage: typeof sourceImage === "string" ? sourceImage : null,
    sourceRef,
    confidence,
    needsReview: needsReview === true,
  };
}

/* ── tree loading & cross-file checks ──────────────────────────────────── */

/**
 * True when `target` really is inside `root` after resolution.
 *
 * Defence in depth for the media checks below. Today `IMAGE_FILE_RE` already
 * makes an escaping name impossible (no separators, no dots before `.webp`), so
 * this never fires — but the safety of `path.join(...)` here would otherwise
 * depend on a regex in a different module. If that rule is ever widened, the
 * containment check is what still stops a read outside the media root.
 */
function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

export interface LoadedTree {
  units: Map<number, { unit: UnitContent; file: string }>;
  lessons: Map<number, { lesson: LessonContent; file: string }>;
  quizzes: Array<{ quiz: QuizContent; file: string }>;
}

function readJsonFiles(dir: string): Array<{ file: string; raw: unknown }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort()
    .map((file) => {
      const full = path.join(dir, file);
      try {
        return { file, raw: JSON.parse(fs.readFileSync(full, "utf8")) as unknown };
      } catch {
        return { file, raw: undefined };
      }
    });
}

function isWebpMagic(buffer: Buffer): boolean {
  return (
    buffer.length > 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  );
}

/**
 * Records a caller is about to commit, keyed by `lessons/<file>`.
 *
 * `media:sync` uses this to validate the tree it is *about* to write: it builds
 * every corrected record in memory, asks for a verdict on those, and only then
 * touches the disk. Without it the validator would judge the stale file and
 * report a path as invalid one line after the sync canonicalised it.
 *
 * Overrides replace the parsed record for that file only; they never introduce
 * a file that does not exist on disk, so counts and cross-file checks are
 * unaffected.
 */
export interface TreeValidationOptions {
  lessonOverrides?: ReadonlyMap<string, LessonContent>;
}

/**
 * Reads a media file relative to the media root, descriptor by descriptor.
 *
 * Returns `null` when the file is absent. A symlinked component is refused rather
 * than followed, so validation cannot be tricked into hashing a file outside the
 * tree — which would otherwise let a record's `sha256` be "valid" against bytes
 * that are not part of the repository.
 */
function readMediaInside(resolvedMediaRoot: string, relative: string): Buffer | null {
  let rootHandle: ReturnType<typeof openDir> | null = null;
  let parent: ReturnType<typeof openDir> | null = null;
  try {
    if (!fs.existsSync(resolvedMediaRoot)) return null;
    const parts = relative.split("/").filter((part) => part !== "" && part !== ".");
    const leaf = parts.pop();
    if (leaf === undefined) return null;
    rootHandle = openDir(resolvedMediaRoot);
    parent = openDirUnder(rootHandle, parts);
    return readFileAt(parent, leaf);
  } catch {
    return null;
  } finally {
    parent?.close();
    rootHandle?.close();
  }
}

/**
 * Walks `mediaRoot/lessons` and reports unreferenced `.webp` files.
 *
 * Every step is relative to an open directory descriptor, and a level that is a
 * symbolic link is skipped: its target is not part of this repository, so neither
 * its files nor its absence may influence the result. Descriptors are closed in
 * `finally` at each level.
 */
function scanOrphansByDescriptor(
  resolvedMediaRoot: string,
  referencedMedia: Set<string>,
  warn: (code: string, file: string, message: string) => void,
): void {
  if (!fs.existsSync(resolvedMediaRoot)) return;
  let rootHandle: ReturnType<typeof openDir> | null = null;
  let lessonsHandle: ReturnType<typeof openDirUnder> | null = null;
  try {
    rootHandle = openDir(resolvedMediaRoot);
    try {
      lessonsHandle = openDirUnder(rootHandle, ["lessons"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // no media yet
      throw error;
    }
    if (lessonsHandle === null) return;

    for (const entry of lessonsHandle.list()) {
      const lessonDirName = entry.name;
      if (!/^\d+$/.test(lessonDirName)) continue;
      // A lesson "folder" that is a link is not walked: its contents are outside.
      // `lstat` on the entry: a link is skipped, never traversed.
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;

      let lessonHandle: ReturnType<typeof openDirUnder> | null = null;
      try {
        lessonHandle = openDirUnder(lessonsHandle, [lessonDirName]);
        walkOrphanDir(lessonHandle, `lessons/${lessonDirName}`, "", referencedMedia, warn);
      } catch {
        // A folder that cannot be opened is not evidence of anything; skip it.
        continue;
      } finally {
        lessonHandle?.close();
      }
    }
  } finally {
    lessonsHandle?.close();
    rootHandle?.close();
  }
}

/** Recursive half of `scanOrphansByDescriptor`, one descriptor per level. */
function walkOrphanDir(
  dir: ReturnType<typeof openDirUnder>,
  sitePrefix: string,
  prefix: string,
  referencedMedia: Set<string>,
  warn: (code: string, file: string, message: string) => void,
): void {
  for (const entry of dir.list()) {
    const name = entry.name;
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (entry.isSymbolicLink()) continue; // never followed
    if (entry.isDirectory()) {
      let child: ReturnType<typeof openDirUnder> | null = null;
      try {
        child = openDirUnder(dir, [name]);
        walkOrphanDir(child, sitePrefix, rel, referencedMedia, warn);
      } catch {
        continue;
      } finally {
        child?.close();
      }
      continue;
    }
    if (!entry.isFile()) continue; // FIFO, socket, device: not a media file
    const siteRel = `${sitePrefix}/${rel}`;
    if (name.toLowerCase().endsWith(".webp") && !referencedMedia.has(siteRel)) {
      warn("IMAGE_ORPHAN", siteRel, "file on disk is not referenced by any lesson");
    }
  }
}

export function validateContentTree(
  contentRoot: string,
  mediaRoot?: string,
  options: TreeValidationOptions = {},
): TreeValidation {
  const errors: ContentIssue[] = [];
  const warnings: ContentIssue[] = [];
  const error = (code: string, path: string, message: string) =>
    errors.push({ code, path, message });
  const warn = (code: string, path: string, message: string) =>
    warnings.push({ code, path, message });

  /* Unit files: filename must equal id (e.g. 1.json <-> id 1). */
  const units = new Map<number, { unit: UnitContent; file: string }>();
  for (const { file, raw } of readJsonFiles(path.join(contentRoot, "units"))) {
    const label = `units/${file}`;
    if (raw === undefined) {
      error("INVALID_JSON", label, "file does not contain valid JSON");
      continue;
    }
    const parsed = parseFileId(file);
    if (parsed && !parsed.canonical) {
      error(
        "FILENAME_NOT_CANONICAL",
        label,
        `filename must be a canonical positive integer without leading zeros ("${parsed.id}.json")`,
      );
    }
    const fileId = parsed?.id ?? null;
    const { value, issues } = validateUnit(raw, label);
    errors.push(...issues);
    if (!value) continue;
    if (fileId !== value.id) {
      error("FILE_ID_MISMATCH", label, `filename implies id ${fileId ?? "?"} but the file declares id ${value.id}`);
    }
    const previous = units.get(value.id);
    if (previous) {
      error("DUPLICATE_ID", label, `unit id ${value.id} is declared by both ${previous.file} and ${label}; neither was dropped — fix one filename or id`);
    } else {
      units.set(value.id, { unit: value, file: label });
    }
  }
  const unitPositions = new Map<number, number>();
  for (const { unit, file } of units.values()) {
    const clash = unitPositions.get(unit.position);
    if (clash !== undefined) {
      error("DUPLICATE_UNIT_POSITION", file, `position ${unit.position} is already used by unit ${clash}`);
    } else {
      unitPositions.set(unit.position, unit.id);
    }
  }

  /* Lesson files. */
  const lessons = new Map<number, { lesson: LessonContent; file: string }>();
  for (const { file, raw: rawFromDisk } of readJsonFiles(path.join(contentRoot, "lessons"))) {
    const label = `lessons/${file}`;
    // A pending write wins: the caller is validating what it is about to commit.
    const override = options.lessonOverrides?.get(label);
    const raw: unknown = override ?? rawFromDisk;
    if (raw === undefined) {
      error("INVALID_JSON", label, "file does not contain valid JSON");
      continue;
    }
    const parsed = parseFileId(file);
    if (parsed && !parsed.canonical) {
      error(
        "FILENAME_NOT_CANONICAL",
        label,
        `filename must be a canonical positive integer without leading zeros ("${parsed.id}.json")`,
      );
    }
    const fileId = parsed?.id ?? null;
    const { value, issues } = validateLesson(raw, label);
    errors.push(...issues);
    if (!value) continue;
    if (fileId !== value.id) {
      error("FILE_ID_MISMATCH", label, `filename implies id ${fileId ?? "?"} but the file declares id ${value.id}`);
    }
    const previous = lessons.get(value.id);
    if (previous) {
      error("DUPLICATE_ID", label, `lesson id ${value.id} is declared by both ${previous.file} and ${label}; neither was dropped — fix one filename or id`);
    } else {
      lessons.set(value.id, { lesson: value, file: label });
    }
  }
  const lessonPositions = new Map<string, number>();
  const lastInUnit = new Map<number, number>();
  for (const { lesson, file } of lessons.values()) {
    if (!units.has(lesson.unitId)) {
      error("UNIT_NOT_FOUND", `${file}#/unitId`, `lesson references missing unit ${lesson.unitId}`);
    }
    const posKey = `${lesson.unitId}:${lesson.position}`;
    const clash = lessonPositions.get(posKey);
    if (clash !== undefined) {
      error(
        "DUPLICATE_LESSON_POSITION",
        file,
        `position ${lesson.position} is already used by lesson ${clash} in unit ${lesson.unitId}`,
      );
    } else {
      lessonPositions.set(posKey, lesson.id);
    }
    if (lesson.isLastInUnit) {
      const other = lastInUnit.get(lesson.unitId);
      if (other !== undefined) {
        error(
          "LAST_IN_UNIT_DUPLICATE",
          file,
          `lesson ${other} and lesson ${lesson.id} are both flagged as the last lesson of unit ${lesson.unitId}`,
        );
      } else {
        lastInUnit.set(lesson.unitId, lesson.id);
      }
    }
  }

  /* Quiz files: identity comes from the filename (lesson-<id> / unit-<id>). */
  const quizzes: Array<{ quiz: QuizContent; file: string }> = [];
  const quizDir = path.join(contentRoot, "quizzes");
  for (const { file, raw } of readJsonFiles(quizDir)) {
    const label = `quizzes/${file}`;
    if (raw === undefined) {
      error("INVALID_JSON", label, "file does not contain valid JSON");
      continue;
    }
    const nameMatch = /^(lesson|unit)-(\d{1,9})\.json$/.exec(file);
    if (!nameMatch) {
      error("QUIZ_FILENAME_INVALID", label, 'quiz filenames must be "lesson-<id>.json" or "unit-<id>.json"');
      continue;
    }
    const [, fileScope, fileTargetRaw] = nameMatch;
    if (fileTargetRaw && !CANONICAL_ID_RE.test(fileTargetRaw)) {
      error(
        "FILENAME_NOT_CANONICAL",
        label,
        `filename must use a canonical positive integer without leading zeros ("${fileScope}-${Number(fileTargetRaw)}.json")`,
      );
    }
    const fileTarget = Number(fileTargetRaw);
    const { value, issues } = validateQuiz(raw, label);
    errors.push(...issues);
    if (!value) continue;
    if (value.scope !== fileScope) {
      error("QUIZ_SCOPE_MISMATCH", label, `filename implies scope "${fileScope}" but the file declares scope "${value.scope}"`);
    }
    const fileTargetValue = value.scope === "lesson" ? value.lessonId : value.unitId;
    if (fileTargetValue !== fileTarget) {
      error("QUIZ_SCOPE_MISMATCH", label, `filename implies target ${fileTarget} but the file declares ${fileTargetValue}`);
    }
    if (value.scope === "lesson" && value.lessonId !== null && !lessons.has(value.lessonId)) {
      error("QUIZ_TARGET_NOT_FOUND", `${label}#/lessonId`, `quiz references missing lesson ${value.lessonId}`);
    }
    if (value.scope === "unit" && value.unitId !== null && !units.has(value.unitId)) {
      error("QUIZ_TARGET_NOT_FOUND", `${label}#/unitId`, `quiz references missing unit ${value.unitId}`);
    }
    quizzes.push({ quiz: value, file: label });
  }

  /* At most one quiz per (scope, target) — even across different spellings. */
  const quizzesByTarget = new Map<string, string[]>();
  for (const { quiz, file } of quizzes) {
    const target = quiz.scope === "lesson" ? quiz.lessonId : quiz.unitId;
    if (target === null) continue;
    const key = `${quiz.scope}:${target}`;
    const files = quizzesByTarget.get(key) ?? [];
    files.push(file);
    quizzesByTarget.set(key, files);
  }
  for (const [key, files] of quizzesByTarget) {
    if (files.length > 1) {
      const [scope, target] = key.split(":");
      error(
        "QUIZ_DUPLICATE_TARGET",
        files.join(", "),
        `more than one quiz targets ${scope} ${target}: ${files.join(", ")} — keep exactly one`,
      );
    }
  }

  /* Media checks: existence, WebP magic bytes, sha256 of stored files. */
  let mediaBytes = 0;
  const referencedMedia = new Set<string>();
  const resolvedMediaRoot = mediaRoot ?? path.join(process.cwd(), "public", "media");
  const mediaExists = fs.existsSync(resolvedMediaRoot);
  if (!mediaExists) {
    if (lessons.size > 0) {
      warn("MEDIA_ROOT_MISSING", resolvedMediaRoot, "media root not found; file-level checks were skipped");
    }
  } else {
    for (const { lesson, file } of lessons.values()) {
      for (const image of lesson.images) {
        const rel = `lessons/${lesson.id}/${image.file}`;
        const full = path.join(resolvedMediaRoot, "lessons", String(lesson.id), image.file);
        const thumbFullEarly = path.join(resolvedMediaRoot, "lessons", String(lesson.id), image.thumb);
        if (!isInsideRoot(resolvedMediaRoot, full) || !isInsideRoot(resolvedMediaRoot, thumbFullEarly)) {
          error(
            "IMAGE_PATH_ESCAPES_MEDIA_ROOT",
            `${file}#/images`,
            `${rel} resolves outside the media root; refusing to read it`,
          );
          continue;
        }
        referencedMedia.add(rel);
        referencedMedia.add(`lessons/${lesson.id}/${image.thumb}`);
        // Read through a pinned descriptor rather than by path: `existsSync` then
        // `readFileSync` is a check-then-use pair, and the media tree is written by
        // uploads. The bytes come from the descriptor that was verified.
        const buffer = readMediaInside(resolvedMediaRoot, rel);
        if (buffer === null) {
          error("IMAGE_NOT_FOUND", `${file}#/images`, `missing media file ${rel}`);
          continue;
        }
        mediaBytes += buffer.byteLength;
        if (!isWebpMagic(buffer)) {
          error("IMAGE_NOT_WEBP", `${file}#/images`, `${rel} is not a WebP file`);
          continue;
        }
        const digest = crypto.createHash("sha256").update(buffer).digest("hex");
        if (digest !== image.sha256) {
          error("IMAGE_HASH_MISMATCH", `${file}#/images`, `sha256 of ${rel} does not match the lesson record`);
        }
        const thumbBuffer = readMediaInside(resolvedMediaRoot, `lessons/${lesson.id}/${image.thumb}`);
        if (thumbBuffer === null) {
          error("IMAGE_THUMB_NOT_FOUND", `${file}#/images`, `missing thumbnail lessons/${lesson.id}/${image.thumb}`);
        } else {
          mediaBytes += thumbBuffer.byteLength;
          if (!isWebpMagic(thumbBuffer)) {
            error("IMAGE_NOT_WEBP", `${file}#/images`, `lessons/${lesson.id}/${image.thumb} is not a WebP file`);
          }
        }
      }
    }
    /* Orphan detection: files on disk not referenced by any lesson. */
    // Walked by descriptor, not by path. `readdirSync(dir)` on `public/media` would
    // enter whatever a symlinked lesson folder points at, so a directory outside
    // the repository could both hide real orphans and manufacture warnings from
    // files that are not part of the tree. `lstat` decides the type, so a link is
    // skipped rather than followed.
    scanOrphansByDescriptor(resolvedMediaRoot, referencedMedia, warn);
  }

  /* Cross-checks between quizzes and assessments. */
  for (const { quiz, file } of quizzes) {
    const targetImages: string[] = [];
    if (quiz.scope === "lesson" && quiz.lessonId !== null) {
      const entry = lessons.get(quiz.lessonId);
      if (entry) targetImages.push(...entry.lesson.images.map((i) => i.file));
    } else if (quiz.scope === "unit" && quiz.unitId !== null) {
      for (const { lesson } of lessons.values()) {
        if (lesson.unitId === quiz.unitId) targetImages.push(...lesson.images.map((i) => i.file));
      }
    }
    const sourceImages =
      quiz.scope === "lesson" && quiz.lessonId !== null
        ? lessons.get(quiz.lessonId)?.lesson.images ?? []
        : [];
    if (quiz.scope === "lesson" && quiz.status !== "idle" && quiz.status !== "generating") {
      const fingerprint = computeSourceFingerprint(sourceImages);
      if (quiz.sourceFingerprint !== "" && quiz.sourceFingerprint !== fingerprint) {
        warn(
          "QUIZ_SOURCE_STALE",
          file,
          "sourceFingerprint does not match the current lesson images; the quiz is stale",
        );
      }
    }
    for (const version of quiz.versions) {
      for (const question of version.questions) {
        if (question.sourceImage && !targetImages.includes(question.sourceImage)) {
          error(
            "SOURCE_IMAGE_NOT_FOUND",
            `${file}#/versions/${version.versionNumber}`,
            `question references image "${question.sourceImage}" which is not part of the assessed content`,
          );
        }
      }
    }
  }

  /* Stats. */
  const publishedLessons = [...lessons.values()].filter(({ lesson }) => lesson.status === "published").length;
  const stats: ContentStats = {
    ...EMPTY_STATS,
    units: units.size,
    lessons: lessons.size,
    publishedLessons,
    draftLessons: lessons.size - publishedLessons,
    images: [...lessons.values()].reduce((n, { lesson }) => n + lesson.images.length, 0),
    quizzes: quizzes.length,
    mediaBytes,
  };

  return { errors, warnings, stats };
}
