import { useTranslations } from "next-intl";

export function SiteFooter() {
  const t = useTranslations("footer");
  return (
    <footer className="mt-20 border-t border-line-soft py-8">
      <div className="mx-auto max-w-6xl px-4 text-center text-xs leading-relaxed text-faint sm:px-6">
        <p>{t("note")}</p>
        <p className="mt-1">{t("personal")}</p>
      </div>
    </footer>
  );
}
