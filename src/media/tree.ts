/**
 * Reading and writing the local content tree.
 *
 * Used by the CLI tools (media import/sync). Kept separate from the pure
 * modules so the write surface is small and auditable: every function that
 * writes takes an explicit root, refuses to escape it, and never deletes.
 */

import fs from "node:fs";
import path from "node:path";
import { validateContentTree, type TreeValidation } from "../content/validate";
import type { LessonContent, UnitContent } from "../content/model";

export interface ContentPaths {
  contentRoot: string;
  mediaRoot: string;
}

export function defaultPaths(root = process.cwd()): ContentPaths {
  return { contentRoot: path.join(root, "content"), mediaRoot: path.join(root, "public", "media") };
}

export function readJsonDir<T>(dir: string): Array<{ file: string; value: T }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return { file: entry.name, value: JSON.parse(fs.readFileSync(full, "utf8")) as T };
    });
}

export function readUnits(contentRoot: string): Array<{ file: string; value: UnitContent }> {
  return readJsonDir<UnitContent>(path.join(contentRoot, "units"));
}

export function readLessons(contentRoot: string): Array<{ file: string; value: LessonContent }> {
  return readJsonDir<LessonContent>(path.join(contentRoot, "lessons"));
}

export function readQuizFiles(contentRoot: string): Array<{ file: string; value: unknown }> {
  return readJsonDir<unknown>(path.join(contentRoot, "quizzes"));
}

export function readLesson(contentRoot: string, lessonId: number): { file: string; value: LessonContent } {
  const file = path.join(contentRoot, "lessons", `${lessonId}.json`);
  if (!fs.existsSync(file)) throw new Error(`lesson ${lessonId} not found at content/lessons/${lessonId}.json`);
  return { file: `${lessonId}.json`, value: JSON.parse(fs.readFileSync(file, "utf8")) as LessonContent };
}

/** Writes JSON with a trailing newline, creating the parent directory. */
export function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeLesson(contentRoot: string, lesson: LessonContent): string {
  const target = path.join(contentRoot, "lessons", `${lesson.id}.json`);
  writeJson(target, lesson);
  return target;
}

/** Re-runs the real content validator against a tree. */
export function validatePaths(paths: ContentPaths, strict = false): TreeValidation {
  const result = validateContentTree(paths.contentRoot, paths.mediaRoot);
  if (strict) {
    return { ...result, errors: [...result.errors, ...result.warnings], warnings: [] };
  }
  return result;
}

export function nowIso(): string {
  return new Date().toISOString();
}
