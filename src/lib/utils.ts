/** Conditional class joiner — no dependency needed for this. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function slugifyLoose(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Picks an accent colour deterministically so a unit keeps its colour forever. */
export const UNIT_ACCENTS = [
  "teal",
  "sky",
  "indigo",
  "violet",
  "rose",
  "amber",
  "emerald",
  "cyan",
] as const;

export type UnitAccent = (typeof UNIT_ACCENTS)[number];

export function accentVar(accent: string): string {
  const known: readonly string[] = UNIT_ACCENTS;
  return known.includes(accent) ? accent : "teal";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
