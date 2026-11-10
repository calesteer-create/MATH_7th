/**
 * Sveltia CMS configuration — generated, not hand-edited.
 *
 * Why generated: the collections below mirror the content model in
 * src/content/model.ts field by field, and the media paths mirror
 * docs/CONTENT_MODEL.md. Hand-maintaining a 200-line YAML file guarantees
 * drift, so `npm run admin:config` writes public/admin/config.yml from this
 * module and `npm run admin:config:check` fails CI when the committed file and
 * the generator disagree.
 *
 * ⚠ STATUS: EXPERIMENTAL / UNVERIFIED (PR 5).
 *   Sveltia has *not* been proven against a real private GitHub repository in
 *   this PR. See docs/ADMIN.md § "Verification status" and
 *   `npm run admin:verify-github`. Nothing in the Next app depends on this file
 *   yet; it is served as a static asset only.
 *
 * Design constraints that shaped the field set:
 *   - Sveltia writes JSON with `format: json`, so `content/**\/*.json` round-trips.
 *   - Fields the CMS cannot compute (sha256, width, height, thumb, derived
 *     timestamps) are marked `readonly` and are completed by the Node pipeline
 *     (`npm run media:sync`). They are present so that a save does not silently
 *     drop them.
 *   - `media_libraries.all.transformations.raster_image.format: webp` makes the
 *     browser transcode uploads to WebP; WebP has no EXIF/GPS container, so the
 *     metadata strip in docs/CONTENT_MODEL.md §6 holds for CMS uploads too.
 */

import { DRAFT_BRANCH, resolveDraftRepo } from "./repo-guard";

export const ADMIN_CONFIG_PATH = "public/admin/config.yml";
export const ADMIN_INDEX_PATH = "public/admin/index.html";

/** Unit accents accepted by the content model (src/lib/utils.ts). */
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

/** Phase badge shown on the /admin/ page until private-repo support is proven. */
export const ADMIN_STATUS = {
  stage: "experimental",
  verifiedAgainstPrivateRepo: false,
  verifiedAt: null as string | null,
  note:
    "Sveltia CMS integration is NOT verified for private repositories yet. " +
    "Run `npm run admin:verify-github` against the real drafts repository and " +
    "then sign in and save one entry from the browser before treating it as ready.",
} as const;

interface CmsConfigOptions {
  /** `owner/name` of the private drafts repository. */
  repo: string;
  branch?: string;
  /** Site URL shown in the CMS UI (the public Pages site). */
  siteUrl?: string;
}

type Scalar = string | number | boolean | null;
/**
 * Config values are assembled from many object literals with optional keys, so
 * `undefined` has to be part of the type; the YAML writer drops those keys.
 */
export type YamlValue =
  | Scalar
  | undefined
  | YamlValue[]
  | { [key: string]: YamlValue };

/** Minimal YAML writer: enough for the shapes used below, stable key order. */
export function toYaml(value: YamlValue, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    const items = value.filter((item): item is Exclude<YamlValue, undefined> => item !== undefined);
    if (items.length === 0) return `${pad}[]`;
    return items
      .map((item): string => {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          const body = toYaml(item, indent + 1);
          // "- " on the first line, aligned body afterwards.
          return `${pad}- ${body.trimStart()}`;
        }
        if (Array.isArray(item)) {
          // Nested list of lists: indent one level deeper under the dash.
          return `${pad}-
${toYaml(item, indent + 1)}`;
        }
        return `${pad}- ${renderScalar(item)}`;
      })
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as { [key: string]: YamlValue }).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([key, child]) => {
        const rendered = renderScalarSafe(child);
        if (rendered !== null) return `${pad}${key}: ${rendered}`;
        const nested = toYaml(child as YamlValue, indent + 1);
        // Lists keep their dashes at the parent indent (YAML allows "- " under
        // a key at the same level or one deeper; one deeper is unambiguous).
        return `${pad}${key}:\n${nested}`;
      })
      .join("\n");
  }
  if (value === undefined) return "";
  return `${pad}${renderScalar(value)}`;
}

function renderScalarSafe(value: YamlValue): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.length === 0 ? "[]" : null;
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length === 0 ? "{}" : null;
  }
  return renderScalar(value);
}

function renderScalar(value: Scalar): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Always double-quote strings: the YAML stays valid for Arabic text, colons,
  // regex characters and templates such as {{slug}}.
  return JSON.stringify(value);
}

/** Shared hint for the derived image fields (Hidden fields cannot carry one). */
const IMAGE_DERIVED_HINT =
  "thumb/width/height/bytes/sha256 are computed by `npm run media:sync`; " +
  "the CMS cannot produce them and they must not be typed by hand.";

/** Fields the CMS shows but never owns — completed by `npm run media:sync`. */
const derivedImageFields = [
  {
    name: "thumb",
    label: "Thumbnail (derived)",
    widget: "hidden",
    // A Hidden field in Sveltia accepts only name/label/default, so the hint
    // lives on the list field instead (imageFieldsHint below).
  },
  {
    name: "width",
    label: "Width (derived)",
    widget: "number",
    required: false,
    value_type: "int",
    readonly: true,
    hint: "Filled in by `npm run media:sync` from the stored WebP.",
  },
  {
    name: "height",
    label: "Height (derived)",
    widget: "number",
    required: false,
    value_type: "int",
    readonly: true,
    hint: "Filled in by `npm run media:sync` from the stored WebP.",
  },
  {
    name: "bytes",
    label: "Original upload size (derived)",
    widget: "number",
    required: false,
    value_type: "int",
    readonly: true,
    hint: "Informational only; the original stays on the owner's machine.",
  },
  {
    name: "sha256",
    label: "sha256 of the stored WebP (derived)",
    widget: "string",
    required: false,
    readonly: true,
    hint: "Content integrity hash. `npm run media:sync` computes it; do not type it.",
  },
];

export function buildAdminConfig(options: CmsConfigOptions): YamlValue {
  const branch = options.branch ?? DRAFT_BRANCH;
  return {
    backend: {
      name: "github",
      repo: options.repo,
      branch,
      // Access token only: no OAuth worker is deployed for this project, and
      // the owner is the single editor (docs/ADMIN.md §2).
      auth_methods: ["token"],
    },
    // Structure-mode editorial workflow is intentionally NOT used: entries are
    // saved straight to the drafts branch so the Node pipeline can read them.
    // Publishing to the public site is a separate, manual step (PR 6).
    publish_mode: "simple",
    site_url: options.siteUrl ?? "https://calesteer-create.github.io/MATH_7th/",
    display_url: options.siteUrl ?? "https://calesteer-create.github.io/MATH_7th/",
    app_title: "MATH 7TH — إدارة المسودات (تجريبي)",
    logo_url: "/MATH_7th/favicon.ico",
    media_folder: "public/media/lessons/{{slug}}",
    public_folder: "/media/lessons/{{slug}}",
    media_libraries: {
      all: {
        max_file_size: 15 * 1024 * 1024,
        transformations: {
          raster_image: {
            // WebP output has no EXIF/GPS block — the metadata strip is
            // structural, not a post-processing step.
            format: "webp",
            quality: 82,
            width: 2200,
            height: 2200,
          },
          svg: { optimize: true },
        },
      },
    },
    slug: { encoding: "ascii", lowercase: true },
    collections: [
    {
      name: "units",
      label: "الوحدات — Units",
      label_singular: "وحدة",
      icon: "menu_book",
      folder: "content/units",
      extension: "json",
      format: "json",
      create: true,
      delete: false,
      identifier_field: "titleAr",
      slug: { template: "{{fields.id}}", editable: false },
      summary: "#{{fields.position}} · {{fields.titleAr}}",
      sortable_fields: ["position", "id", "titleAr"],
      view_groups: {
        groups: [
          { name: "published", label: "منشورة", field: "archived", eq: false },
          { name: "archived", label: "مؤرشفة", field: "archived", eq: true },
        ],
      },
      fields: [
        {
          name: "id",
          label: "معرّف الوحدة (رقم فريد، وهو اسم الملف)",
          widget: "number",
          value_type: "int",
          required: true,
          min: 1,
          hint: "يُكتب في اسم الملف: 3 → content/units/3.json. لا يمكن تعديله بعد الإنشاء.",
        },
        {
          name: "position",
          label: "ترتيب الوحدة",
          widget: "number",
          value_type: "int",
          required: true,
          min: 1,
          hint: "فريد على مستوى كل الوحدات. يعمل مع أزرار الترتيب في قائمة الوحدات.",
        },
        { name: "titleAr", label: "العنوان (عربي)", widget: "string", required: true, maxlength: 200 },
        { name: "titleEn", label: "Title (English)", widget: "string", required: false, maxlength: 200 },
        {
          name: "descriptionAr",
          label: "الوصف (عربي)",
          widget: "text",
          required: false,
          maxlength: 1000,
        },
        {
          name: "descriptionEn",
          label: "Description (English)",
          widget: "text",
          required: false,
          maxlength: 1000,
        },
        { name: "pageFrom", label: "من صفحة", widget: "string", required: false, maxlength: 20 },
        { name: "pageTo", label: "إلى صفحة", widget: "string", required: false, maxlength: 20 },
        {
          name: "accent",
          label: "لون الوحدة",
          widget: "select",
          required: true,
          default: "teal",
          options: [...UNIT_ACCENTS],
        },
        {
          name: "createdAt",
          label: "أُنشئت في",
          widget: "datetime",
          required: true,
          format: "YYYY-MM-DDTHH:mm:ss.SSS[Z]",
          picker_utc: true,
          readonly: true,
        },
        {
          name: "updatedAt",
          label: "آخر تحديث",
          widget: "datetime",
          required: true,
          format: "YYYY-MM-DDTHH:mm:ss.SSS[Z]",
          picker_utc: true,
          readonly: true,
          auto_now: true,
        },
      ],
    },
    { divider: true },
    {
      name: "lessons",
      label: "الدروس — Lessons",
      label_singular: "درس",
      icon: "description",
      folder: "content/lessons",
      extension: "json",
      format: "json",
      create: true,
      delete: false,
      identifier_field: "titleAr",
      slug: { template: "{{fields.id}}", editable: false },
      summary: "{{fields.status}} · #{{fields.position}} · {{fields.titleAr}}",
      sortable_fields: ["unitId", "position", "id", "titleAr", "status", "updatedAt"],
      view_groups: {
        groups: [
          { name: "drafts", label: "مسودات", field: "status", eq: "draft" },
          { name: "published", label: "منشورة", field: "status", eq: "published" },
        ],
      },
      fields: [
        {
          name: "id",
          label: "معرّف الدرس (رقم فريد، وهو اسم الملف)",
          widget: "number",
          value_type: "int",
          required: true,
          min: 1,
        },
        {
          name: "unitId",
          label: "الوحدة",
          widget: "relation",
          collection: "units",
          value_field: "{{fields.id}}",
          search_fields: ["titleAr", "titleEn", "id"],
          display_fields: ["#{{id}} {{titleAr}}"],
          required: true,
          hint: "يجب أن تكون الوحدة موجودة مسبقًا في مجموعة الوحدات.",
        },
        {
          name: "position",
          label: "ترتيب الدرس داخل الوحدة",
          widget: "number",
          value_type: "int",
          required: true,
          min: 1,
        },
        { name: "titleAr", label: "العنوان (عربي)", widget: "string", required: true, maxlength: 200 },
        { name: "titleEn", label: "Title (English)", widget: "string", required: false, maxlength: 200 },
        {
          name: "pageLabel",
          label: "إشارة الصفحات",
          widget: "string",
          required: false,
          maxlength: 100,
          hint: "مثال: «ص 24–29». حقل نصي حر.",
        },
        {
          name: "status",
          label: "حالة النشر",
          widget: "select",
          required: true,
          default: "draft",
          options: [
            { label: "مسودة", value: "draft" },
            { label: "منشور", value: "published" },
          ],
          hint:
            "«منشور» هنا يعني جاهزًا للنشر — لا يُنشر شيء تلقائيًا. النشر العام يدوي (PR 6).",
        },
        {
          name: "isLastInUnit",
          label: "آخر درس في الوحدة",
          widget: "boolean",
          required: false,
          default: false,
        },
        {
          name: "publishedAt",
          label: "تاريخ النشر",
          widget: "datetime",
          required: false,
          format: "YYYY-MM-DDTHH:mm:ss.SSS[Z]",
          picker_utc: true,
        },
        {
          name: "contentUpdatedAt",
          label: "آخر تحديث للمحتوى",
          widget: "datetime",
          required: true,
          format: "YYYY-MM-DDTHH:mm:ss.SSS[Z]",
          picker_utc: true,
          readonly: true,
          hint: "أسّ اكتشاف تقادم الاختبارات (sourceFingerprint). يحدّثه media:sync.",
        },
        {
          name: "createdAt",
          label: "أُنشئ في",
          widget: "datetime",
          required: true,
          format: "YYYY-MM-DDTHH:mm:ss.SSS[Z]",
          picker_utc: true,
          readonly: true,
        },
        {
          name: "updatedAt",
          label: "آخر تحديث",
          widget: "datetime",
          required: true,
          format: "YYYY-MM-DDTHH:mm:ss.SSS[Z]",
          picker_utc: true,
          readonly: true,
          auto_now: true,
        },
        {
          name: "images",
          label: "صفحات الدرس (صور WebP)",
          widget: "list",
          required: false,
          collapsed: true,
          summary: "#{{fields.position}} · {{fields.file}}",
          hint:
            "ترتيب الصور = ترتيب العرض. الرفع من المتصفح يحوّل تلقائيًا إلى WebP ويحذف EXIF/GPS، " +
            "لكن sha256 والمصغّرات والأبعاد تُحسب محليًا بـ `npm run media:sync`. " +
            IMAGE_DERIVED_HINT,
          fields: [
            {
              name: "position",
              label: "ترتيب الصورة",
              widget: "number",
              value_type: "int",
              required: true,
              min: 1,
            },
            {
              name: "file",
              label: "الملف",
              widget: "image",
              required: true,
              media_libraries: { default: { config: { slugify_filename: true } } },
            },
            ...derivedImageFields,
          ],
        },
      ],
    },
    { divider: true },
    {
      name: "settings",
      label: "إعدادات المنصة",
      icon: "settings",
      files: [
        {
          name: "site",
          label: "بيانات الموقع",
          file: "content/site.json",
          fields: [
            { name: "titleAr", label: "عنوان الموقع (عربي)", widget: "string", required: false },
            { name: "titleEn", label: "Site title (English)", widget: "string", required: false },
            { name: "notes", label: "ملاحظات المالك", widget: "text", required: false },
          ],
        },
      ],
    },
    ],
  };
}

export const ADMIN_CONFIG_BANNER = `# ⚠ AUTO-GENERATED — do not edit by hand.
# Source: src/media/cms-config.ts   Regenerate: npm run admin:config
# STATUS: EXPERIMENTAL — Sveltia CMS has NOT been verified against a real
# private GitHub repository yet. See docs/ADMIN.md and
# \`npm run admin:verify-github\` before relying on this panel.
#
# The backend below points at the PRIVATE DRAFTS repository. Committing here
# never publishes anything: there is no publish workflow in this PR.
`;

/** Full file text for public/admin/config.yml. */
export function renderAdminConfig(options: CmsConfigOptions): string {
  return `${ADMIN_CONFIG_BANNER}\n${toYaml(buildAdminConfig(options))}\n`;
}

/** Resolved config used by the generator, the tests and the docs. */
export function currentAdminOptions(env: Record<string, string | undefined> = {}): CmsConfigOptions {
  const resolution = resolveDraftRepo(env);
  if (resolution.problem) {
    throw new Error(`refusing to generate the admin config: ${resolution.problem}`);
  }
  return { repo: resolution.repo, branch: DRAFT_BRANCH };
}
