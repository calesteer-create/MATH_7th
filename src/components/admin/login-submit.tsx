import { buttonClass, fieldClass, labelClass } from "@/components/ui/primitives";

/**
 * Native form POST to /api/admin/login. No client JavaScript is required to sign
 * in, which keeps the one authenticated flow in the product simple and testable.
 */
export function LoginSubmit({
  locale,
  hasError,
  labels,
}: {
  locale: string;
  hasError: boolean;
  labels: { username: string; password: string; submit: string; error: string };
}) {
  return (
    <form action="/api/admin/login" method="post" className="mt-6 space-y-4">
      <input type="hidden" name="locale" value={locale} />
      <div>
        <label htmlFor="username" className={labelClass}>
          {labels.username}
        </label>
        <input id="username" name="username" autoComplete="username" required maxLength={80} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="password" className={labelClass}>
          {labels.password}
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className={fieldClass} />
      </div>

      {hasError ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/8 p-3 text-sm text-rose-200">
          {labels.error}
        </p>
      ) : null}

      <button type="submit" className={`${buttonClass("primary", "md")} w-full`}>
        {labels.submit}
      </button>
    </form>
  );
}
