/**
 * Glue between the raw JSON tree and the pure reference helpers, shared by
 * `media:sync` and the deletion audit. Kept separately testable.
 */

import { buildReferenceIndex, collectQuizSourceImages, type QuizReference, type ReferenceableLesson } from "./references";

export { buildReferenceIndex };

/** Turns raw `content/quizzes/*.json` payloads into reference summaries. */
export function collectedQuizReferences(
  files: ReadonlyArray<{ file: string; value: unknown }>,
): QuizReference[] {
  const result: QuizReference[] = [];
  for (const { value } of files) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as { scope?: unknown; lessonId?: unknown; unitId?: unknown };
    const scope = record.scope === "unit" ? "unit" : record.scope === "lesson" ? "lesson" : null;
    if (!scope) continue;
    result.push({
      scope,
      lessonId: typeof record.lessonId === "number" ? record.lessonId : null,
      unitId: typeof record.unitId === "number" ? record.unitId : null,
      sourceImages: collectQuizSourceImages(value),
    });
  }
  return result;
}

export type { QuizReference, ReferenceableLesson };
