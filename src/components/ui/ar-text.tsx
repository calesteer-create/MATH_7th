/**
 * Owner-supplied Arabic content (unit titles, lesson titles, descriptions).
 *
 * The UI locale and the content locale are different things. Lesson material is
 * always Arabic and is never machine-translated, so it always carries its own
 * lang/dir — otherwise an English-UI screen reader pronounces Arabic letter by
 * letter and bidi isolation is lost.
 */
export function Ar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span lang="ar" dir="rtl" className={className}>
      {children}
    </span>
  );
}
