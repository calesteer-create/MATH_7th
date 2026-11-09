#!/usr/bin/env node
/**
 * MATH 7TH project guard.
 *
 * Replaces ESLint for this repository: typescript-eslint does not support
 * TypeScript 7, so eslint-config-next cannot load, and the only rules that
 * actually protect this product are the two below. Both are checked here, in
 * plain Node, with no dependency to drift out of date.
 *
 *   1. RTL-native layout — physical left/right utilities are banned.
 *   2. Western digits — raw Intl / toLocale* calls are banned outside format.ts.
 *
 * Run with: npm run guard     (wired into npm run check)
 */
import fs from "node:fs";
import path from "node:path";

const RTL_BANNED = [
  [/\b(?:sm|md|lg|xl|2xl)?:m[lr]-/, "physical margin (use ms-/me-)"],
  [/\b(?:sm|md|lg|xl|2xl)?:p[lr]-/, "physical padding (use ps-/pe-)"],
  [/\b(?:sm|md|lg|xl|2xl)?:left-/, "physical inset (use start-)"],
  [/\b(?:sm|md|lg|xl|2xl)?:right-/, "physical inset (use end-)"],
  [/\b(?:sm|md|lg|xl|2xl)?:border-[lr]-/, "physical border (use border-s/border-e)"],
  [/\b(?:sm|md|lg|xl|2xl)?:rounded-[lr]-/, "physical radius (use rounded-s/rounded-e)"],
  [/\btext-left\b/, "text-left (use text-start)"],
  [/\btext-right\b/, "text-right (use text-end)"],
  [/\b[pm][lr]-\d/, "physical spacing (use logical utilities)"],
  [/row-reverse/, "row-reverse mirroring hack"],
  [/\buppercase\b/, "uppercase is meaningless for Arabic (no letter case)"],
  // Inline styles escape Tailwind's logical utilities entirely.
  [/\b(?:margin|padding)(?:Left|Right)\b/, "inline physical spacing (use marginInlineStart/End)"],
  [/\bborder(?:Left|Right)\b/, "inline physical border (use borderInlineStart/End)"],
  [/[{,;]\s*(?:left|right)\s*:/, "inline physical inset (use insetInlineStart/End)"],
];

const NUMERAL_BANNED = [
  [/\bIntl\s*\.\s*NumberFormat\b/, "Intl.NumberFormat (use formatNumber/formatCount)"],
  [/\bIntl\s*\.\s*DateTimeFormat\b/, "Intl.DateTimeFormat (use formatDate/formatDateTime)"],
  [/\.toLocaleString\s*\(/, ".toLocaleString (use formatNumber/formatDate)"],
  [/\.toLocaleDateString\s*\(/, ".toLocaleDateString (use formatDate)"],
  [/\.toLocaleTimeString\s*\(/, ".toLocaleTimeString (use formatDateTime)"],
];

/** The single module permitted to touch Intl — it pins numberingSystem to latn. */
const NUMERAL_EXEMPT = new Set([path.join("src", "lib", "format.ts")]);
/** Tests assert the ICU behaviour the guard exists to protect against. */
const NUMERAL_EXEMPT_DIRS = [path.join("tests")];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(path.join(process.cwd(), "src"));
const problems = [];

for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const numeralExempt =
    NUMERAL_EXEMPT.has(rel) || NUMERAL_EXEMPT_DIRS.some((d) => rel.startsWith(d + path.sep));

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (trimmed.includes("guard-ignore")) return;
    // Tailwind's own `rtl:` variant is legitimate, but it only prefixes a single
    // token — strip those tokens rather than skipping the whole line, otherwise a
    // real violation sharing a line with `rtl:` slips through.
    const code = line.replace(/\brtl:[\w[\]/().-]+/g, "");

    for (const [re, why] of RTL_BANNED) {
      // The base CSS rule that disables uppercase for Arabic is the fix, not a violation.
      if (rel.endsWith("globals.css") && why.startsWith("uppercase")) continue;
      if (re.test(code)) problems.push(`RTL      ${rel}:${i + 1}  ${why}`);
    }
    if (!numeralExempt) {
      for (const [re, why] of NUMERAL_BANNED) {
        if (re.test(code)) problems.push(`NUMERALS ${rel}:${i + 1}  ${why}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} violation(s):`);
  for (const p of problems) console.error("  " + p);
  console.error(
    "\nLogical utilities: ms-/me-, ps-/pe-, start-/end-, text-start/text-end, border-s/border-e.\n" +
      "Numbers and dates: import from @/lib/format — it pins Western digits in both languages.",
  );
  process.exit(1);
}
console.log(`✓ guard: ${files.length} files scanned — RTL-native, Western digits enforced`);
