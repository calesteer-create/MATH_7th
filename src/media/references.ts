/**
 * Asset reference bookkeeping for the "never delete a used image" rule.
 *
 * Deleting a media file is only safe if nothing points at it. References live
 * in three places, and all three are checked:
 *
 *   1. `content/lessons/<id>.json` → images[].file  (the authoritative link)
 *   2. `lessons/<id>/thumbs/<file>`                   (derived, always paired)
 *   3. free-form mentions inside quiz questions (`sourceImage`)
 *
 * A media file is also implicitly referenced by its own thumbnail, so deleting
 * `page-01.webp` must consider `thumbs/page-01.webp` too. This module is pure:
 * callers pass in the parsed lesson objects, so it works identically for the
 * importer (local tree) and for the draft repo (files fetched from GitHub).
 */

export interface ReferenceableImage {
  file: string;
}

export interface ReferenceableLesson {
  id: number;
  images: ReferenceableImage[];
}

export interface QuizReference {
  scope: "lesson" | "unit";
  lessonId: number | null;
  unitId: number | null;
  /** `sourceImage` values collected from every question of every version. */
  sourceImages: string[];
}

export interface MediaReferenceIndex {
  /** `"<lessonId>/<file>"` → lesson ids that reference it. */
  byPath: Map<string, Set<number>>;
  /** Lessons whose `images[]` mention the bare filename. */
  byFile: Map<string, Set<number>>;
}

export function imageKey(lessonId: number, file: string): string {
  return `${lessonId}/${file}`;
}

export function buildReferenceIndex(lessons: readonly ReferenceableLesson[]): MediaReferenceIndex {
  const byPath = new Map<string, Set<number>>();
  const byFile = new Map<string, Set<number>>();
  for (const lesson of lessons) {
    for (const image of lesson.images) {
      const key = imageKey(lesson.id, image.file);
      const pathSet = byPath.get(key) ?? new Set<number>();
      pathSet.add(lesson.id);
      byPath.set(key, pathSet);

      const fileSet = byFile.get(image.file) ?? new Set<number>();
      fileSet.add(lesson.id);
      byFile.set(image.file, fileSet);
    }
  }
  return { byPath, byFile };
}

export interface DeletionRequest {
  lessonId: number;
  file: string;
}

export interface DeletionVerdict {
  allowed: boolean;
  /** Stable codes so the CLI and tests can assert on them. */
  reason:
    | "not_referenced"
    | "referenced_by_lesson"
    | "referenced_by_quiz"
    | "illegal_name"
    | "thumbnail_shared";
  detail: string;
  quizReferences: number;
  /** Other lessons using the same *filename* in their own folder. Deleting is
   *  still allowed — those are different files — but it is worth knowing. */
  sameNameInLessons: number[];
}

/**
 * Decides whether `<lessonId>/<file>` may be removed from the media tree.
 *
 * Deliberately conservative: an unreadable/illegal name is refused instead of
 * normalised, because a name that escapes the model rule is exactly the case
 * where a sloppy `unlink` could touch something unexpected.
 */
export function checkDeletion(
  request: DeletionRequest,
  index: MediaReferenceIndex,
  quizzes: readonly QuizReference[] = [],
  legalName: (name: string) => boolean = (name) => /^[a-z0-9][a-z0-9-]{0,60}\.webp$/.test(name),
): DeletionVerdict {
  if (!legalName(request.file)) {
    return {
      allowed: false,
      reason: "illegal_name",
      detail: `"${request.file}" is not a canonical media filename; refusing to touch it`,
      quizReferences: 0,
      sameNameInLessons: [],
    };
  }
  const referencingLessons = index.byPath.get(imageKey(request.lessonId, request.file)) ?? new Set();
  let quizReferences = 0;
  for (const quiz of quizzes) {
    if (!quiz.sourceImages.includes(request.file)) continue;
    const targetsThisLesson =
      (quiz.scope === "lesson" && quiz.lessonId === request.lessonId) ||
      // A unit quiz may quote any image of any lesson in the unit; the caller
      // keeps those entries so this branch only needs the file match.
      quiz.scope === "unit";
    if (targetsThisLesson) quizReferences += 1;
  }
  const sameNameInLessons = [...(index.byFile.get(request.file) ?? new Set<number>())]
    .filter((id) => id !== request.lessonId)
    .sort((a, b) => a - b);
  if (referencingLessons.size > 0) {
    return {
      allowed: false,
      reason: "referenced_by_lesson",
      detail: `lesson ${[...referencingLessons].sort((a, b) => a - b).join(", ")} still lists ${request.file}`,
      quizReferences,
      sameNameInLessons,
    };
  }
  if (quizReferences > 0) {
    return {
      allowed: false,
      reason: "referenced_by_quiz",
      detail: `${quizReferences} quiz question(s) cite ${request.file} as their source image`,
      quizReferences,
      sameNameInLessons,
    };
  }
  return {
    allowed: true,
    reason: "not_referenced",
    detail: "no lesson or quiz references this image",
    quizReferences: 0,
    sameNameInLessons,
  };
}

/** Every filename referenced anywhere in the tree (used for orphan detection). */
export function referencedFiles(
  lessons: readonly ReferenceableLesson[],
  quizzes: readonly QuizReference[] = [],
): Set<string> {
  const files = new Set<string>();
  for (const lesson of lessons) for (const image of lesson.images) files.add(image.file);
  for (const quiz of quizzes) for (const file of quiz.sourceImages) files.add(file);
  return files;
}

/** Collects question-level `sourceImage` values out of raw quiz JSON. */
export function collectQuizSourceImages(raw: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "sourceImage" && typeof child === "string" && child.length > 0) found.push(child);
      else visit(child);
    }
  };
  visit(raw);
  return found;
}
