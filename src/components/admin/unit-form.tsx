import { getTranslations } from "next-intl/server";
import { buttonClass, fieldClass, labelClass } from "@/components/ui/primitives";
import { UNIT_ACCENTS, type UnitAccent } from "@/lib/utils";
import type { Unit } from "@/db/schema";

export async function UnitForm({
  locale,
  action,
  unit,
  submitLabel,
}: {
  locale: string;
  action: (form: FormData) => Promise<void>;
  unit?: Unit;
  submitLabel: string;
}) {
  const t = await getTranslations({ locale, namespace: "admin.units" });

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="titleAr">
            {t("titleAr")} <span className="text-rose-400">*</span>
          </label>
          <input id="titleAr" name="titleAr" required maxLength={200} defaultValue={unit?.titleAr ?? ""} className={fieldClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="titleEn">
            {t("titleEn")}
          </label>
          <input id="titleEn" name="titleEn" dir="ltr" maxLength={200} defaultValue={unit?.titleEn ?? ""} className={fieldClass} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="descriptionAr">
            {t("descriptionAr")}
          </label>
          <textarea id="descriptionAr" name="descriptionAr" rows={2} maxLength={1000} defaultValue={unit?.descriptionAr ?? ""} className={fieldClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="descriptionEn">
            {t("descriptionEn")}
          </label>
          <textarea id="descriptionEn" name="descriptionEn" dir="ltr" rows={2} maxLength={1000} defaultValue={unit?.descriptionEn ?? ""} className={fieldClass} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="pageFrom">
            {t("pageFrom")}
          </label>
          <input id="pageFrom" name="pageFrom" inputMode="numeric" maxLength={20} defaultValue={unit?.pageFrom ?? ""} className={`${fieldClass} bidi-isolate`} />
        </div>
        <div>
          <label className={labelClass} htmlFor="pageTo">
            {t("pageTo")}
          </label>
          <input id="pageTo" name="pageTo" inputMode="numeric" maxLength={20} defaultValue={unit?.pageTo ?? ""} className={`${fieldClass} bidi-isolate`} />
        </div>
        <div>
          <label className={labelClass} htmlFor="accent">
            {t("accent")}
          </label>
          <select id="accent" name="accent" defaultValue={unit?.accent ?? "teal"} className={fieldClass}>
            {UNIT_ACCENTS.map((a: UnitAccent) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <button type="submit" className={buttonClass("primary", "md")}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
