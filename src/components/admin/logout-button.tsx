export function LogoutButton({ label, locale }: { label: string; locale: string }) {
  return (
    <form action="/api/admin/logout" method="post">
      <input type="hidden" name="locale" value={locale} />
      <button
        type="submit"
        className="rounded-lg border border-white/10 px-3 py-2 text-sm text-muted transition-colors hover:border-rose-500/40 hover:text-rose-300"
      >
        {label}
      </button>
    </form>
  );
}
