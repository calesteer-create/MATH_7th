/**
 * The generated Sveltia config (PR 5).
 *
 * What is tested here:
 *   1. the YAML is valid and accepted by Sveltia's own published JSON schema;
 *   2. every field maps onto the content model — no invented fields, no
 *      silently missing required ones;
 *   3. every name `view_groups`/`sortable_fields` refers to resolves to a real
 *      field — Sveltia treats a dangling name as a fatal error, not a warning,
 *      so the editor refuses to mount (the `archived` regression);
 *   4. the backend can only ever point at the drafts repository, never at the
 *      public site;
 *   5. `public/admin/index.html` uses the mount element the CMS actually looks
 *      for (`#nc-root`), self-initializes, and pins the installed bundle by SRI.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import YAML from "yaml";
import {
  ADMIN_CONFIG_PATH,
  ADMIN_STATUS,
  CMS_MOUNT_ID,
  GLOBAL_MEDIA_FOLDER,
  GLOBAL_PUBLIC_FOLDER,
  LESSON_MEDIA_FOLDER,
  LESSON_PUBLIC_FOLDER,
  buildAdminConfig,
  currentAdminOptions,
  declaredFieldNames,
  renderAdminConfig,
  sortableFieldKeys,
  toYaml,
  undefinedFieldReferences,
  viewGroupFields,
} from "@/media/cms-config";
import { DRAFT_REPO_DEFAULT, PUBLIC_REPO, classifyRepo, resolveDraftRepo } from "@/media/repo-guard";
import { canonicalMediaFile } from "@/media/naming";

const SCHEMA_PATH = path.join(
  process.cwd(),
  "node_modules",
  "@sveltia",
  "cms",
  "schema",
  "sveltia-cms.json",
);

function committedConfigText(): string {
  return fs.readFileSync(path.join(process.cwd(), ADMIN_CONFIG_PATH), "utf8");
}

function committedConfig(): Record<string, unknown> {
  return YAML.parse(committedConfigText()) as Record<string, unknown>;
}

type Collection = {
  name?: string;
  divider?: boolean;
  folder?: string;
  files?: unknown[];
  fields?: Field[];
  slug?: unknown;
  view_groups?: unknown;
  [key: string]: unknown;
};
type Field = {
  name?: string;
  widget?: string;
  fields?: Field[];
  required?: boolean;
  readonly?: boolean;
  options?: unknown[];
  [key: string]: unknown;
};

function collection(config: Record<string, unknown>, name: string): Collection {
  const collections = config["collections"] as Collection[];
  const found = collections.find((entry) => entry.name === name);
  if (!found) throw new Error(`collection ${name} missing`);
  return found;
}

function field(collectionEntry: Collection, name: string): Field {
  const found = (collectionEntry.fields ?? []).find((entry) => entry.name === name);
  if (!found) throw new Error(`field ${name} missing in ${collectionEntry.name}`);
  return found;
}

describe("generated YAML", () => {
  it("is valid YAML and round-trips", () => {
    const parsed = YAML.parse(renderAdminConfig(currentAdminOptions({})));
    expect(typeof parsed).toBe("object");
    expect(parsed.backend.name).toBe("github");
  });

  it("escapes strings that would otherwise break YAML", () => {
    const yaml = toYaml({ a: 'quote " and colon: and {{slug}}', b: "#hash", c: "line\nbreak" });
    const parsed = YAML.parse(yaml) as Record<string, string>;
    expect(parsed.a).toBe('quote " and colon: and {{slug}}');
    expect(parsed.b).toBe("#hash");
    expect(parsed.c).toBe("line\nbreak");
  });

  it("is untouched by a refused DRAFT_REPO (generator exits non-zero, file unchanged)", async () => {
    const { spawn } = await import("node:child_process");
    const before = committedConfigText();
    for (const foreign of ["someone/site-assets", "calesteer-create/MATH_7th-notes", PUBLIC_REPO]) {
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "scripts/admin-config.ts"],
          {
            cwd: process.cwd(),
            env: { ...process.env, DRAFT_REPO: foreign },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stderr }));
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/refusing to generate the admin config/);
      // The committed file is byte-identical: a refusal never half-writes.
      expect(committedConfigText()).toBe(before);
    }
  }, 60_000);

  it("is exactly what the generator produces (no hand edits)", () => {
    expect(committedConfigText()).toBe(renderAdminConfig(currentAdminOptions({})));
  });

  it("stays valid against Sveltia's own published JSON schema", () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as object;
    const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
    const validate = ajv.compile(schema);
    const config = committedConfig();
    // Key order is irrelevant to the schema; the generator's order is stable.
    const ok = validate(config);
    if (!ok) {
      const messages = (validate.errors ?? []).map(
        (error) => `${error.instancePath || "/"} ${error.message ?? ""}`,
      );
      throw new Error(`Sveltia schema rejected the config:\n  ${messages.join("\n  ")}`);
    }
    expect(ok).toBe(true);
  }, 30_000);
});

describe("content-model parity", () => {
  const config = committedConfig();

  it("has the collections the project needs", () => {
    const names = (config["collections"] as Collection[]).map((entry) => entry.name).filter(Boolean);
    expect(names).toEqual(["units", "lessons", "settings"]);
  });

  it("writes units to content/units and lessons to content/lessons as JSON", () => {
    const units = collection(config, "units");
    const lessons = collection(config, "lessons");
    expect(units.folder).toBe("content/units");
    expect(lessons.folder).toBe("content/lessons");
    for (const entry of [units, lessons]) {
      expect(entry["format"]).toBe("json");
      expect(entry["extension"]).toBe("json");
    }
  });

  it("uses the numeric id as the filename, exactly like the validator demands", () => {
    for (const name of ["units", "lessons"]) {
      const entry = collection(config, name);
      expect(entry.slug).toEqual({ template: "{{fields.id}}", editable: false });
      expect(field(entry, "id").required).toBe(true);
    }
  });

  it("orders units and lessons through `position`", () => {
    expect(field(collection(config, "units"), "position").required).toBe(true);
    expect(field(collection(config, "lessons"), "position").required).toBe(true);
    // The list views can sort by it, which is how the editor reorders.
    expect(collection(config, "units")["sortable_fields"]).toContain("position");
    expect(collection(config, "lessons")["sortable_fields"]).toContain("position");
  });

  it("covers every required lesson field of the model", () => {
    const lessons = collection(config, "lessons");
    const required = ["id", "unitId", "position", "titleAr", "status"];
    for (const name of required) expect(field(lessons, name).required).toBe(true);
    // The model accepts `images: []`, so the list itself is optional in the
    // CMS; a published lesson still needs at least one image, and the
    // validator (not the CMS) enforces that.
    expect(field(lessons, "images")).toBeDefined();
    const optional = [
      "titleEn",
      "pageLabel",
      "isLastInUnit",
      "publishedAt",
      "contentUpdatedAt",
      "createdAt",
      "updatedAt",
    ];
    for (const name of optional) expect(field(lessons, name)).toBeDefined();
  });

  it("offers exactly the statuses the model accepts", () => {
    const status = field(collection(config, "lessons"), "status");
    expect(status.widget).toBe("select");
    const values = (status.options as Array<{ value?: string }>).map((option) => option.value);
    expect(values).toEqual(["draft", "published"]);
  });

  it("offers exactly the accents the model accepts", () => {
    const accent = field(collection(config, "units"), "accent");
    expect(accent.options).toEqual([
      "teal",
      "sky",
      "indigo",
      "violet",
      "rose",
      "amber",
      "emerald",
      "cyan",
    ]);
  });

  it("links lessons to units with a relation, not a free-text id", () => {
    const unitId = field(collection(config, "lessons"), "unitId");
    expect(unitId.widget).toBe("relation");
    expect(unitId["collection"]).toBe("units");
    expect(unitId["value_field"]).toBe("{{fields.id}}");
  });

  it("keeps the CMS-derivable image fields editable and the derived ones read-only", () => {
    const images = field(collection(config, "lessons"), "images");
    expect(images.widget).toBe("list");
    const itemFields = (images.fields ?? []).map((entry) => entry.name);
    expect(itemFields).toEqual(["position", "file", "thumb", "width", "height", "bytes", "sha256"]);
    const file = (images.fields ?? []).find((entry) => entry.name === "file")!;
    expect(file.widget).toBe("image");
    for (const derived of ["width", "height", "sha256"]) {
      const entry = (images.fields ?? []).find((candidate) => candidate.name === derived)!;
      expect(entry.readonly).toBe(true);
    }
  });

  it("converts uploads to WebP with the same ceiling as the Node pipeline", () => {
    const libraries = config["media_libraries"] as {
      all: { transformations: { raster_image: { format: string; width: number; height: number } }; max_file_size: number };
    };
    expect(libraries.all.transformations.raster_image.format).toBe("webp");
    expect(libraries.all.transformations.raster_image.width).toBe(2200);
    expect(libraries.all.transformations.raster_image.height).toBe(2200);
    expect(libraries.all.max_file_size).toBe(15 * 1024 * 1024);
  });

  it("groups the lesson list by draft/published state", () => {
    const groups = (collection(config, "lessons")["view_groups"] as { groups: Array<{ field: string; eq: string }> })
      .groups;
    expect(groups.map((group) => group.field)).toEqual(["status", "status"]);
    expect(groups.map((group) => group.eq)).toEqual(["draft", "published"]);
  });

  it("disables deletion of content collections (no accidental data loss)", () => {
    // `delete: false` is a documented per-collection option in Sveltia 0.262.1
    // ("Whether to allow users to delete entries in the collection. Default:
    // true."). The runtime honours it in three places:
    //   - contents/collection/view/index.js:  canDelete = !readonly && (delete ?? true)
    //   - contents/editor/toolbar.js:          canDelete = !(entry && delete === false)
    //   - components/workflow/workflow-entry-card.svelte
    // This pins both halves — the flag and the widget options it needs to be
    // offered at all — so a generator edit cannot quietly re-enable deletion.
    for (const name of ["units", "lessons"]) {
      expect(collection(config, name)["delete"]).toBe(false);
      expect(collection(config, name)["create"]).toBe(true);
    }
  });
});

/**
 * The `archived` regression (F1).
 *
 * Sveltia 0.262.1 treats `view_groups`/`sortable_fields` naming an undefined
 * field as a **fatal** config error (`views.js` → `addMessage()` default type
 * `error` → `collectors.errors` → `initCmsConfig` throws → the entrance page
 * shows the error list instead of the sign-in form; the editor never mounts).
 * The published JSON schema accepts any string there, so schema validation
 * alone passed while the panel was unusable.
 *
 * These tests compare every such name against the collection's own `fields`,
 * which is the same lookup Sveltia performs, so the regression cannot return.
 */
describe("field references resolve (the F1 regression)", () => {
  const config = committedConfig();
  const collections = (): Collection[] =>
    (config["collections"] as Collection[]).filter((entry) => !entry.divider);

  it("has no view group or sort key pointing at an undefined field", () => {
    const offenders = collections()
      .map((entry) => ({ name: String(entry.name), missing: undefinedFieldReferences(entry) }))
      .filter(({ missing }) => missing.length > 0);

    expect(offenders, `Sveltia would refuse to mount: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("has no view groups on the units collection at all", () => {
    // The content model gives units no publish/archive state (docs/CONTENT_MODEL.md
    // §2, docs/ADMIN.md §2 «الحالات»), so there is no field a group could filter on.
    const units = collection(config, "units");
    expect(units["view_groups"]).toBeUndefined();
    expect(viewGroupFields(units)).toEqual([]);
  });

  it("keeps the lesson groups, which do refer to a real field", () => {
    const lessons = collection(config, "lessons");
    expect(viewGroupFields(lessons)).toEqual(["status", "status"]);
    expect(declaredFieldNames(lessons)).toContain("status");
  });

  it("catches the exact `archived` mistake when it is reintroduced", () => {
    const units = collection(config, "units");
    const regressed: Collection = {
      ...units,
      view_groups: {
        groups: [
          { name: "published", label: "منشورة", field: "archived", eq: false },
          { name: "archived", label: "مؤرشفة", field: "archived", eq: true },
        ],
      },
    };
    expect(undefinedFieldReferences(regressed)).toContain("archived");
    // …and the pre-fix committed YAML is caught too, not just the generator.
    const previousYaml = [
      "collections:",
      "  - name: units",
      "    folder: content/units",
      "    fields:",
      '      - { name: "id", widget: number }',
      "    view_groups:",
      "      groups:",
      '        - { name: published, field: archived, eq: false }',
    ].join("\n");
    const parsed = YAML.parse(previousYaml) as { collections: Collection[] };
    expect(undefinedFieldReferences(parsed.collections[0]!)).toEqual(["archived"]);
  });

  it("flags an undefined key in sortable_fields but allows Sveltia's own keys", () => {
    const units = collection(config, "units");
    expect(undefinedFieldReferences({ ...units, sortable_fields: ["position", "nope"] })).toEqual([
      "nope",
    ]);
    // `_summary`, `_manual`, `slug`, `commit_author`, `commit_date` are resolved
    // without a field definition (parser/utils/fields.js `isNonFieldSortKey`,
    // table-keys.js `SUMMARY_COLUMN_KEY`), so they must not be reported.
    expect(
      undefinedFieldReferences({
        ...units,
        sortable_fields: ["position", "_summary", "_manual", "slug", "commit_author", "commit_date"],
      }),
    ).toEqual([]);
  });

  it("reads both accepted shapes of view_groups and sortable_fields", () => {
    const units = collection(config, "units");
    expect(viewGroupFields({ ...units, view_groups: [{ field: "titleAr" }] })).toEqual(["titleAr"]);
    expect(
      sortableFieldKeys({ ...units, sortable_fields: { default: "position", fields: ["position"] } }),
    ).toEqual(["position"]);
    // A group with no `field` is not a field reference at all.
    expect(viewGroupFields({ ...units, view_groups: { groups: [{ name: "x" }] } })).toEqual([]);
  });

  it("does not report nested relation templates as missing fields", () => {
    // Deliberately out of scope: `value_field`/`display_fields` are templates.
    const lessons = collection(config, "lessons");
    expect(undefinedFieldReferences(lessons)).toEqual([]);
  });
});

describe("repository guard — drafts only", () => {
  it("points the backend at the private drafts repository", () => {
    const config = committedConfig();
    const backend = config["backend"] as { repo: string; branch: string; auth_methods: string[] };
    expect(backend.repo).toBe(DRAFT_REPO_DEFAULT);
    expect(backend.repo).not.toBe(PUBLIC_REPO);
    expect(backend.branch).toBe("main");
    expect(backend.auth_methods).toEqual(["token"]);
  });

  it("never generates a config for the public repository", () => {
    expect(() => currentAdminOptions({ DRAFT_REPO: PUBLIC_REPO })).toThrow(/PUBLIC repository/);
    // The builder refuses too: no caller can emit a config that points the CMS
    // at the public site, even by calling the low-level function directly.
    expect(() => buildAdminConfig({ repo: PUBLIC_REPO })).toThrow(/PUBLIC repository/);
    expect(() => buildAdminConfig({ repo: "Calesteer-Create/MATH_7TH" })).toThrow(/PUBLIC repository/);
    expect(() => currentAdminOptions({ DRAFT_REPO: "not a repo" })).toThrow(/owner\/name/);
  });

  it("classifies repositories by role", () => {
    expect(classifyRepo(PUBLIC_REPO)).toBe("public");
    expect(classifyRepo("calesteer-create/MATH_7th.git")).toBe("public");
    expect(classifyRepo(DRAFT_REPO_DEFAULT)).toBe("draft");
    expect(classifyRepo("someone/else")).toBe("foreign");
  });

  it("refuses to rename the drafts repository via DRAFT_REPO", () => {
    // A name is not proof that a repository is private, so the generator has no
    // way to accept another target offline. Renaming needs a code change plus a
    // live check; an environment variable must not redirect drafts.
    for (const foreign of [
      "calesteer-create/MATH_7th-notes",
      "someone/else",
      "calesteer-create/site-assets",
    ]) {
      const resolution = resolveDraftRepo({ DRAFT_REPO: foreign });
      expect(resolution.problem).toMatch(/not the agreed drafts destination/);
      expect(resolution.privacyProvable).toBe(false);
      expect(() => currentAdminOptions({ DRAFT_REPO: foreign })).toThrow(/not the agreed drafts destination/);
    }
  });

  it("accepts DRAFT_REPO only when it restates the agreed destination", () => {
    for (const spelling of [
      DRAFT_REPO_DEFAULT,
      DRAFT_REPO_DEFAULT.toUpperCase(),
      `${DRAFT_REPO_DEFAULT}.git`,
      `${DRAFT_REPO_DEFAULT}/`,
      `  ${DRAFT_REPO_DEFAULT}  `,
    ]) {
      expect(currentAdminOptions({ DRAFT_REPO: spelling }).repo).toBe(DRAFT_REPO_DEFAULT);
    }
  });

  it("refuses a PUBLIC repository passed as DRAFT_REPO, by name and by visibility", () => {
    expect(() => currentAdminOptions({ DRAFT_REPO: PUBLIC_REPO })).toThrow(/PUBLIC repository/);
    expect(() => currentAdminOptions({ DRAFT_REPO: "someone/site-assets" })).toThrow(/not the agreed/);
    // And the builder refuses even when a caller claims GitHub said private.
    expect(() =>
      buildAdminConfig({ repo: "someone/site-assets", branch: "main" } as never),
    ).toThrow();
  });

  it("only the agreed destination produces the expected config", () => {
    const rendered = renderAdminConfig(currentAdminOptions({}));
    expect(rendered).toContain(`repo: "${DRAFT_REPO_DEFAULT}"`);
    expect(rendered).toContain("STATUS: EXPERIMENTAL");
    const parsed = YAML.parse(rendered.replace(/^#.*$/gm, "")) as { backend: { repo: string } };
    expect(parsed.backend.repo).toBe(DRAFT_REPO_DEFAULT);
  });

  it("records that the integration is unverified", () => {
    expect(ADMIN_STATUS.stage).toBe("experimental");
    expect(ADMIN_STATUS.verifiedAgainstPrivateRepo).toBe(false);
  });
});

describe("public/admin/index.html", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "admin", "index.html"), "utf8");

  it("pins the audited CMS version with subresource integrity", () => {
    expect(html).toContain("@sveltia/cms@0.262.1/dist/sveltia-cms.js");
    const integrity = /integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(html);
    expect(integrity?.[1]).toBeDefined();
    expect(integrity?.[1]).not.toContain("REPLACE");
  });

  it("pins the SRI hash of the CMS bundle that is actually installed", () => {
    // The `integrity` attribute and node_modules must agree: if the pinned
    // version is ever bumped without recomputing the hash, the browser blocks
    // the script and the panel is dead — while every other test still passes.
    const bundle = path.join(
      process.cwd(),
      "node_modules",
      "@sveltia",
      "cms",
      "dist",
      "sveltia-cms.js",
    );
    if (!fs.existsSync(bundle)) {
      // `npm ci` always installs it; skip loudly rather than pass silently.
      throw new Error(`cannot verify SRI: ${bundle} is missing`);
    }
    const digest = createHash("sha384").update(fs.readFileSync(bundle)).digest("base64");
    const integrity = /integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(html)?.[1];
    expect(integrity).toBe(`sha384-${digest}`);

    // …and the pinned URL's version is the installed version.
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "node_modules", "@sveltia", "cms", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(html).toContain(`@sveltia/cms@${installed.version}/dist/sveltia-cms.js`);
  });

  it("declares the experimental status and the drafts-only destination", () => {
    expect(html).toContain("EXPERIMENTAL");
    expect(html).toContain("MATH_7th-drafts");
    expect(html).toContain('name="robots"');
  });

  it("never embeds a credential", () => {
    for (const pattern of [/ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /gho_[A-Za-z0-9]{20,}/]) {
      expect(pattern.test(html)).toBe(false);
    }
  });

  it("does not load any other third-party script", () => {
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);
    expect(scripts).toEqual(["https://unpkg.com/@sveltia/cms@0.262.1/dist/sveltia-cms.js"]);
  });
});

/**
 * The mount point (F2/F3).
 *
 * Sveltia 0.262.1 mounts on `#nc-root` or, failing that, on `<body>`
 * (services/api/methods/init.js). `#cms-mount` — what this page used to carry —
 * appears nowhere in the bundle, so the CMS fell back to `<body>`, was pinned
 * to the whole viewport and added `overflow: hidden` to `<body>`, covering the
 * experimental warning.
 */
describe("public/admin/index.html — Sveltia mount point", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "admin", "index.html"), "utf8");
  /** Where `#nc-root` sits in the document, as source offsets. */
  const mountIndex = html.indexOf(`id="${CMS_MOUNT_ID}"`);

  it("declares the mount element Sveltia actually looks for", () => {
    expect(CMS_MOUNT_ID).toBe("nc-root");
    expect(mountIndex).toBeGreaterThan(-1);
    expect(html).toContain(`<div id="${CMS_MOUNT_ID}"></div>`);
  });

  it("no longer carries the id the CMS ignores", () => {
    // `#cms-mount` was never a Sveltia mount point; only a comment may mention it.
    expect(html).not.toMatch(/id="cms-mount"/);
    expect(html).not.toContain("<div id=\"cms-mount\"");
  });

  it("keeps the mount element outside the notice, so the warning survives", () => {
    const mainOpen = html.indexOf('<main class="notice">');
    const mainClose = html.indexOf("</main>");
    expect(mainOpen).toBeGreaterThan(-1);
    expect(mainClose).toBeGreaterThan(mainOpen);
    // Outside <main>…</main>: the CMS replaces its target's content, so a
    // nested mount point would delete the experimental banner.
    expect(mountIndex).toBeGreaterThan(mainClose);
  });

  it("still loads the CMS so it can initialize on its own", () => {
    // A classic script ending in /sveltia-cms.js self-initializes (lib/main.js);
    // `type="module"` would turn that off, and manual init is not used here.
    // Comments are dropped first: they are allowed to *mention* these names,
    // they just must not be code.
    const code = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(code).not.toMatch(/<script[^>]*type="module"/);
    expect(code).not.toContain("CMS_MANUAL_INIT");
    expect(code).not.toContain("CMS.init");
    expect(code).toMatch(/<script[^>]*src="https:\/\/unpkg\.com\/@sveltia\/cms@0\.262\.1\/dist\/sveltia-cms\.js"/);
  });

  it("keeps the experimental warning on the page after the fixes", () => {
    expect(html).toContain("EXPERIMENTAL");
    expect(html).toContain("MATH_7th-drafts");
    expect(html).toContain("role=\"status\"");
  });
});

/**
 * G1 / G2 — the media-folder options (found by running the 0.262.1 bundle).
 *
 * G1: Sveltia validates the ROOT `media_folder`/`public_folder` with
 *     `isGlobal: true` (config/parser/index.js → `umt` → `D9`). In that mode the
 *     guard `(isGlobal || !cmt.includes(tag) && !smt.includes(name))` is
 *     unconditionally true, so *any* `{{…}}` tag is pushed to
 *     `collectors.errors` through `y8()` (default type `'error'`) and
 *     `initCmsConfig` throws "Errors found in configuration" before the editor
 *     mounts. Verified by calling the bundle's own `umt()`: the previous value
 *     `public/media/lessons/{{slug}}` produced
 *     `config.error.global_folder_template_tag`.
 *
 * G2: a collection-level `media_folder` that does not start with `/` makes
 *     `parseAssetFolder()` (`Lze`) set `entryRelative: true`, which turns
 *     `internalPath` into the *collection folder* and the template into an
 *     `internalSubPath` — uploads would land in
 *     `content/lessons/public/media/lessons/<id>/…`, while
 *     src/media/tree.ts reads `public/media/lessons/<id>/…`.
 */
describe("media folders — G1/G2", () => {
  const config = committedConfig();
  const TEMPLATE_TAG = /\{\{[^}]+\}\}/;

  it("keeps the root media folders free of template tags (G1)", () => {
    // A tag here is a FATAL config error, not a warning: the editor never mounts.
    expect(String(config["media_folder"])).not.toMatch(TEMPLATE_TAG);
    expect(String(config["public_folder"])).not.toMatch(TEMPLATE_TAG);
    expect(config["media_folder"]).toBe(GLOBAL_MEDIA_FOLDER);
    expect(config["public_folder"]).toBe(GLOBAL_PUBLIC_FOLDER);
  });

  it("still defines the root media_folder (missing_media_folder is fatal)", () => {
    expect(typeof config["media_folder"]).toBe("string");
    expect(String(config["media_folder"]).length).toBeGreaterThan(0);
  });

  it("starts the collection media_folder with a slash, so it is not entry-relative (G2)", () => {
    const lessons = collection(config, "lessons");
    expect(lessons["media_folder"]).toBe(LESSON_MEDIA_FOLDER);
    expect(lessons["public_folder"]).toBe(LESSON_PUBLIC_FOLDER);
    expect(String(lessons["media_folder"]).startsWith("/")).toBe(true);
    // …and that resolved path is exactly where src/media/tree.ts looks.
    expect(String(lessons["media_folder"])).toBe("/public/media/lessons/{{slug}}");
    expect(String(lessons["public_folder"])).toBe("/media/lessons/{{slug}}");
  });

  it("uses an absolute public folder — Sveltia rejects relative and URL forms", () => {
    expect(String(config["public_folder"]).startsWith("/")).toBe(true);
    expect(/^https?:/.test(String(config["public_folder"]))).toBe(false);
    expect(/^\.{1,2}\//.test(String(config["public_folder"]))).toBe(false);
  });

  it("leaves the global Media Library config intact", () => {
    // Moving the templates onto the collection must not change the global
    // library: `media_libraries.all` still carries the limits/transformations.
    const libraries = config["media_libraries"] as {
      all: { max_file_size: number; transformations: { raster_image: { format: string } } };
    };
    expect(libraries.all.max_file_size).toBe(15 * 1024 * 1024);
    expect(libraries.all.transformations.raster_image.format).toBe("webp");
    // The units collection inherits the global folders: it declares none.
    const units = collection(config, "units");
    expect(units["media_folder"]).toBeUndefined();
    expect(units["public_folder"]).toBeUndefined();
  });
});

/**
 * The regression guard that ties the two halves together.
 *
 * For the public path the generated config implies, `canonicalMediaFile` must
 * return the bare name the content model demands. If someone edits
 * `public_folder` later, this fails in CI instead of at the owner's keyboard.
 */
describe("CMS value → content-model value", () => {
  it("canonicalises the path the configured public_folder produces", () => {
    const config = committedConfig();
    const lessons = collection(config, "lessons");
    const template = String(lessons["public_folder"]);
    for (const lessonId of [1, 7, 42]) {
      for (const fileName of ["page-01.webp", "page-12.webp"]) {
        // Sveltia substitutes {{slug}} with the entry slug (the numeric id).
        const stored = `${template.replace("{{slug}}", String(lessonId))}/${fileName}`;
        expect(canonicalMediaFile(stored, lessonId)).toBe(fileName);
        expect(/^[a-z0-9][a-z0-9-]{0,60}\.webp$/.test(canonicalMediaFile(stored, lessonId)!)).toBe(true);
      }
    }
  });

  it("also canonicalises the repository-relative form of the same file", () => {
    expect(canonicalMediaFile("public/media/lessons/7/page-12.webp", 7)).toBe("page-12.webp");
  });

  it("returns null for the same path aimed at another lesson", () => {
    const config = committedConfig();
    const template = String(collection(config, "lessons")["public_folder"]);
    const stored = `${template.replace("{{slug}}", "9")}/page-01.webp`;
    expect(canonicalMediaFile(stored, 3)).toBeNull();
  });
});
