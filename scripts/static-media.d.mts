/**
 * Types for scripts/static-media.mjs.
 *
 * The implementation is plain ESM because the build script and the Pages
 * auditor both import it without a transpiler; this declaration gives the
 * TypeScript side (tests, `npm run typecheck`) the same contract, so a change
 * to the plan shape cannot drift past the compiler.
 */
export declare const MEDIA_FILE_RE: RegExp;

export interface ScanCopyEntry {
  lessonId: number;
  variant: "web" | "thumb";
  /** Absolute path in public/media/lessons/<id>/… */
  source: string;
  /** Path under the artefact root: media/lessons/<id>/… */
  relative: string;
}

export interface ScanCopyPlan {
  plan: ScanCopyEntry[];
  /** Referenced scans with no file — a published lesson must not ship without them. */
  missing: Array<{ lessonId: number; variant: "web" | "thumb"; file: string; source: string }>;
  /** Referenced filenames that fail the naming rule. */
  invalid: Array<{ lessonId: number; file: string }>;
}

/** Ids of published lessons ([] when the tree does not exist yet). */
export declare function publishedLessonIds(contentRoot: string): number[];

/** Every scan file that must exist in the published artefact. */
export declare function staticScanCopyPlan(contentRoot: string, mediaRoot: string): ScanCopyPlan;
