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
  /** Absolute path in public/media/lessons/<id>/… (for messages only). */
  source: string;
  /** Path under the artefact root: media/lessons/<id>… */
  relative: string;
  /** Exactly the bytes read through the checked, link-free descriptor. */
  bytes: Buffer;
  /** SHA-256 of `bytes`; re-verified after the write. */
  sha256: string;
}

export interface ScanPlan {
  plan: ScanCopyEntry[];
  /** Referenced by a published lesson but absent — the build must fail. */
  missing: Array<{ lessonId: number; variant: "web" | "thumb"; file: string; source: string }>;
  /** Filename breaks the naming rule — the build must fail. */
  invalid: Array<{ lessonId: number; file: string }>;
  /** A symlink or non-regular component, or an unreadable tree — the build must fail. */
  unsafe: Array<{ lessonId: number; variant: "web" | "thumb"; file: string; reason: string }>;
}

/** Ids of published lessons read through descriptors; [] only when the tree is absent. */
export declare function publishedLessonIds(contentRoot: string): number[];

/** Every scan that must exist in the published artefact, already verified. */
export declare function staticScanCopyPlan(contentRoot: string, mediaRoot: string): ScanPlan;
