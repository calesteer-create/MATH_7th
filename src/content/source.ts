/**
 * The site's content source — one interface, two storage backends.
 *
 * WHY THIS MODULE EXISTS
 * Public pages used to read SQLite directly (`@/lib/queries`). The published
 * site, however, is a static GitHub Pages export whose only durable content is
 * the JSON tree in `content/`: the database is gitignored (`data/*.db`), so
 * anything that lives only there can never reach a student. Reads were
 * therefore split by *build mode*, and this module is the single seam:
 *
 *   - static export (`npm run build:static`) → `content/*.json`
 *   - server build    (`npm run build` / `npm run dev`) → SQLite, unchanged
 *
 * Pages import ONLY from here, so a page can never accidentally read the wrong
 * store: there is exactly one place that decides, and it is decided by the
 * build markers in `src/lib/base-path.ts` (never by a per-page flag).
 *
 * WHY NOT ONE STORE FOR BOTH MODES
 * The owner's admin panel is a running-server feature that writes to SQLite
 * (`src/app/[locale]/admin/actions.ts`), and `tests/server-mode.test.ts` pins
 * that behaviour — including "content inserted after the build appears without
 * a rebuild". Switching the server to read JSON would delete that capability
 * before a replacement exists, which the project rules forbid. The published
 * artefact, meanwhile, must come from git so that every published word is
 * reviewable in a diff. So the split is deliberate and documented, and the
 * shared types below are what keeps the two stores from drifting apart.
 *
 * The shapes below are structurally identical to the Drizzle rows the pages
 * previously consumed (`isLastInUnit` stays 0 | 1, not a boolean), so switching
 * a page to this module is a pure data-source change with no JSX churn.
 *
 * INTERFACE CONTRACT (enforced by tests/content-source.test.ts, runtime)
 * The test is written against this import list on purpose: ADDING an export
 * here is free, but the dispatch test then fails until the new export is
 * exercised in both modes — which is exactly the reminder we want, because a
 * page that reads a missing function fails on one host only.
 *
 *   listUnits · getUnit · listLessons · listPublishedLessonIds
 *   getLessonWithUnit · listLessonImages · overviewStats · unitIsComplete
 */
import fs from "node:fs";
import path from "node:path";
import { isStaticExport } from "../lib/base-path";
import type { LessonContent, UnitContent } from "./model";
import {
  getLessonWithUnit as dbGetLessonWithUnit,
  getUnit as dbGetUnit,
  listLessonImages as dbListLessonImages,
  listLessons as dbListLessons,
  listPublishedLessonIds as dbListPublishedLessonIds,
  listUnits as dbListUnits,
  overviewStats as dbOverviewStats,
  unitIsComplete as dbUnitIsComplete,
} from "../lib/queries";

/* ── Public shapes (what pages consume) ─────────────────────────────────── */

export interface PublicUnit {
  id: number;
  position: number;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  pageFrom: string;
  pageTo: string;
  accent: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUnitWithCount extends PublicUnit {
  lessonCount: number;
}

export interface PublicLesson {
  id: number;
  unitId: number;
  position: number;
  titleAr: string;
  titleEn: string;
  pageLabel: string;
  status: "draft" | "published";
  /** Kept as 0 | 1 so page-level `lesson.isLastInUnit === 1` stays literal. */
  isLastInUnit: 0 | 1;
  publishedAt: string | null;
  contentUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicLessonImage {
  /** 1-based display position; also the stable React key in the viewer. */
  id: number;
  position: number;
  /** Bare filename inside the lesson media folder, e.g. "page-01.webp". */
  file: string;
  thumb: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  sha256: string;
}

export interface PublicOverview {
  units: number;
  lessons: number;
  published: number;
  drafts: number;
  images: number;
}

/* ── Tree location ──────────────────────────────────────────────────────── */

/**
 * Content and media roots.
 *
 * The defaults are the repository's own trees. `CONTENT_ROOT` / `MEDIA_ROOT`
 * exist so a build (and the build-backed test suites) can point at a
 * disposable tree instead of the working copy — the same escape hatch the CLI
 * tools already expose as `--content` / `--media`.
 */
export function contentRoot(): string {
  return path.resolve(process.env.CONTENT_ROOT ?? path.join(process.cwd(), "content"));
}

export function mediaRoot(): string {
  return path.resolve(process.env.MEDIA_ROOT ?? path.join(process.cwd(), "public", "media"));
}

/* ── JSON readers ───────────────────────────────────────────────────────── */

/** A bad file must fail the build loudly, naming the file — never skip it. */
function readJsonFiles<T>(dir: string): Array<{ file: string; value: T }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      try {
        return { file: entry.name, value: JSON.parse(fs.readFileSync(full, "utf8")) as T };
      } catch (err) {
        throw new Error(
          `invalid JSON in ${path.relative(process.cwd(), full)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}

function readUnitsFromTree(root = contentRoot()): UnitContent[] {
  return readJsonFiles<UnitContent>(path.join(root, "units")).map((entry) => entry.value);
}

function readLessonsFromTree(root = contentRoot()): LessonContent[] {
  return readJsonFiles<LessonContent>(path.join(root, "lessons")).map((entry) => entry.value);
}

/* ── JSON-backed implementations ────────────────────────────────────────── */

function jsonListUnits(): PublicUnitWithCount[] {
  const root = contentRoot();
  const units = readUnitsFromTree(root);
  const published = readLessonsFromTree(root).filter((lesson) => lesson.status === "published");
  return units
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((unit) => ({
      ...unit,
      lessonCount: published.filter((lesson) => lesson.unitId === unit.id).length,
    }));
}

function jsonGetUnit(unitId: number): PublicUnit | undefined {
  return readUnitsFromTree().find((unit) => unit.id === unitId);
}

function jsonListLessons(unitId: number, publishedOnly: boolean): PublicLesson[] {
  return readLessonsFromTree()
    .filter((lesson) => lesson.unitId === unitId && (!publishedOnly || lesson.status === "published"))
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map(toPublicLesson);
}

function toPublicLesson(lesson: LessonContent): PublicLesson {
  return {
    id: lesson.id,
    unitId: lesson.unitId,
    position: lesson.position,
    titleAr: lesson.titleAr,
    titleEn: lesson.titleEn,
    pageLabel: lesson.pageLabel,
    status: lesson.status,
    isLastInUnit: lesson.isLastInUnit ? 1 : 0,
    publishedAt: lesson.publishedAt,
    contentUpdatedAt: lesson.contentUpdatedAt,
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt,
  };
}

function jsonListPublishedLessonIds(): number[] {
  return readLessonsFromTree()
    .filter((lesson) => lesson.status === "published")
    .map((lesson) => lesson.id)
    .sort((a, b) => a - b);
}

function jsonGetLessonWithUnit(
  lessonId: number,
): { lesson: PublicLesson; unit: PublicUnit; siblings: PublicLesson[] } | undefined {
  const root = contentRoot();
  const lesson = readLessonsFromTree(root).find((entry) => entry.id === lessonId);
  if (!lesson) return undefined;
  const unit = readUnitsFromTree(root).find((entry) => entry.id === lesson.unitId);
  if (!unit) return undefined;
  return {
    lesson: toPublicLesson(lesson),
    unit,
    siblings: jsonListLessons(lesson.unitId, true),
  };
}

function jsonListLessonImages(lessonId: number): PublicLessonImage[] {
  const lesson = readLessonsFromTree().find((entry) => entry.id === lessonId);
  if (!lesson) return [];
  return lesson.images
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((image) => ({
      id: image.position,
      position: image.position,
      file: image.file,
      thumb: image.thumb,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
      sha256: image.sha256,
    }));
}

function jsonOverviewStats(): PublicOverview {
  const lessons = readLessonsFromTree();
  const published = lessons.filter((lesson) => lesson.status === "published");
  return {
    units: readUnitsFromTree().length,
    lessons: lessons.length,
    published: published.length,
    drafts: lessons.length - published.length,
    images: published.reduce((sum, lesson) => sum + lesson.images.length, 0),
  };
}

function jsonUnitIsComplete(unitId: number): boolean {
  return readLessonsFromTree().some(
    (lesson) => lesson.unitId === unitId && lesson.isLastInUnit && lesson.status === "published",
  );
}

/* ── Public API (mode-dispatched) ───────────────────────────────────────── */

export function listUnits(): PublicUnitWithCount[] {
  return isStaticExport() ? jsonListUnits() : (dbListUnits() as PublicUnitWithCount[]);
}

export function getUnit(unitId: number): PublicUnit | undefined {
  return isStaticExport() ? jsonGetUnit(unitId) : (dbGetUnit(unitId) as PublicUnit | undefined);
}

export function listLessons(unitId: number, publishedOnly: boolean): PublicLesson[] {
  return isStaticExport()
    ? jsonListLessons(unitId, publishedOnly)
    : (dbListLessons(unitId, publishedOnly) as unknown as PublicLesson[]);
}

/** Ids of every published lesson — the static export pre-renders these pages. */
export function listPublishedLessonIds(): number[] {
  return isStaticExport() ? jsonListPublishedLessonIds() : dbListPublishedLessonIds();
}

export function getLessonWithUnit(
  lessonId: number,
): { lesson: PublicLesson; unit: PublicUnit; siblings: PublicLesson[] } | undefined {
  return isStaticExport()
    ? jsonGetLessonWithUnit(lessonId)
    : (dbGetLessonWithUnit(lessonId) as unknown as
        | { lesson: PublicLesson; unit: PublicUnit; siblings: PublicLesson[] }
        | undefined);
}

export function listLessonImages(lessonId: number): PublicLessonImage[] {
  return isStaticExport()
    ? jsonListLessonImages(lessonId)
    : (dbListLessonImages(lessonId) as unknown as PublicLessonImage[]);
}

export function overviewStats(): PublicOverview {
  return isStaticExport() ? jsonOverviewStats() : dbOverviewStats();
}

/** True when the unit's owner-designated final lesson exists and is published. */
export function unitIsComplete(unitId: number): boolean {
  return isStaticExport() ? jsonUnitIsComplete(unitId) : dbUnitIsComplete(unitId);
}
