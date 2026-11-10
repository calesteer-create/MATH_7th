/**
 * The generated Sveltia config (PR 5).
 *
 * Three properties matter and are all tested here:
 *   1. the YAML is valid and accepted by Sveltia's own published JSON schema;
 *   2. every field maps onto the content model — no invented fields, no
 *      silently missing required ones (requirement 1);
 *   3. the backend can only ever point at the drafts repository, never at the
 *      public site (requirement 5).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import YAML from "yaml";
import {
  ADMIN_CONFIG_PATH,
  ADMIN_STATUS,
  buildAdminConfig,
  currentAdminOptions,
  renderAdminConfig,
  toYaml,
} from "@/media/cms-config";
import { DRAFT_REPO_DEFAULT, PUBLIC_REPO, classifyRepo, resolveDraftRepo } from "@/media/repo-guard";

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
    for (const name of ["units", "lessons"]) {
      expect(collection(config, name)["delete"]).toBe(false);
    }
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
