"use server";

import { and, eq, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { sessionCookie } from "@/lib/auth";
import { deleteKey } from "@/lib/storage";
import { nowIso, UNIT_ACCENTS } from "@/lib/utils";

/** Every mutation re-checks the session. Route guards alone are not enough. */
async function assertOwner(): Promise<void> {
  const store = await cookies();
  const token = store.get(sessionCookie.name)?.value;
  if (!token) throw new Error("unauthorized");
  const { verifySessionToken } = await import("@/lib/auth");
  if (!verifySessionToken(token)) throw new Error("unauthorized");
}

function str(v: FormDataEntryValue | null | undefined, max = 400): string {
  return (v ?? "").toString().trim().slice(0, max);
}

/* ── Units ───────────────────────────────────────────────────────────────── */

export async function createUnitAction(form: FormData) {
  await assertOwner();
  const db = getDb();
  const titleAr = str(form.get("titleAr"), 200);
  if (!titleAr) throw new Error("title_required");

  const max = db.select({ p: schema.units.position }).from(schema.units).all();
  const position = max.reduce((m, r) => Math.max(m, r.p), 0) + 1;
  const now = nowIso();
  const accent = str(form.get("accent"), 20) || UNIT_ACCENTS[position % UNIT_ACCENTS.length]!;

  db.insert(schema.units)
    .values({
      position,
      titleAr,
      titleEn: str(form.get("titleEn"), 200),
      descriptionAr: str(form.get("descriptionAr"), 1000),
      descriptionEn: str(form.get("descriptionEn"), 1000),
      pageFrom: str(form.get("pageFrom"), 20),
      pageTo: str(form.get("pageTo"), 20),
      accent: UNIT_ACCENTS.includes(accent as (typeof UNIT_ACCENTS)[number]) ? accent : "teal",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  revalidatePath("/units");
  revalidatePath("/admin/units");
}

export async function updateUnitAction(unitId: number, form: FormData) {
  await assertOwner();
  const titleAr = str(form.get("titleAr"), 200);
  if (!titleAr) throw new Error("title_required");
  const accent = str(form.get("accent"), 20);
  getDb()
    .update(schema.units)
    .set({
      titleAr,
      titleEn: str(form.get("titleEn"), 200),
      descriptionAr: str(form.get("descriptionAr"), 1000),
      descriptionEn: str(form.get("descriptionEn"), 1000),
      pageFrom: str(form.get("pageFrom"), 20),
      pageTo: str(form.get("pageTo"), 20),
      accent: UNIT_ACCENTS.includes(accent as (typeof UNIT_ACCENTS)[number]) ? accent : "teal",
      updatedAt: nowIso(),
    })
    .where(eq(schema.units.id, unitId))
    .run();
  revalidatePath("/units");
  revalidatePath(`/units/${unitId}`);
  revalidatePath("/admin/units");
}

export async function deleteUnitAction(unitId: number) {
  await assertOwner();
  getDb().delete(schema.units).where(eq(schema.units.id, unitId)).run();
  revalidatePath("/units");
  revalidatePath("/admin/units");
  redirect("/admin/units");
}

/** Reordering is a full rewrite in one transaction — no half-applied orders. */
export async function reorderUnitsAction(orderedIds: number[]) {
  await assertOwner();
  const db = getDb();
  db.transaction((t) => {
    orderedIds.forEach((id, i) => {
      t.update(schema.units).set({ position: i + 1, updatedAt: nowIso() }).where(eq(schema.units.id, id)).run();
    });
  });
  revalidatePath("/units");
  revalidatePath("/admin/units");
}

/* ── Lessons ─────────────────────────────────────────────────────────────── */

export async function createLessonAction(form: FormData) {
  await assertOwner();
  const db = getDb();
  const unitId = Number(form.get("unitId"));
  const titleAr = str(form.get("titleAr"), 200);
  if (!titleAr || !Number.isInteger(unitId)) throw new Error("invalid");

  const siblings = db.select({ p: schema.lessons.position }).from(schema.lessons).where(eq(schema.lessons.unitId, unitId)).all();
  const position = siblings.reduce((m, r) => Math.max(m, r.p), 0) + 1;
  const now = nowIso();

  const info = db
    .insert(schema.lessons)
    .values({
      unitId,
      position,
      titleAr,
      titleEn: str(form.get("titleEn"), 200),
      pageLabel: str(form.get("pageLabel"), 40),
      status: "draft",
      contentUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  revalidatePath("/admin/lessons");
  redirect(`/admin/lessons/${Number(info.lastInsertRowid)}`);
}

export async function updateLessonAction(lessonId: number, form: FormData) {
  await assertOwner();
  const titleAr = str(form.get("titleAr"), 200);
  if (!titleAr) throw new Error("title_required");
  const now = nowIso();
  getDb()
    .update(schema.lessons)
    .set({
      titleAr,
      titleEn: str(form.get("titleEn"), 200),
      pageLabel: str(form.get("pageLabel"), 40),
      contentUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.lessons.id, lessonId))
    .run();
  revalidatePath("/admin/lessons");
  revalidatePath(`/admin/lessons/${lessonId}`);
  revalidatePath("/units");
}

export async function deleteLessonAction(lessonId: number) {
  await assertOwner();
  const db = getDb();
  const images = db.select().from(schema.lessonImages).where(eq(schema.lessonImages.lessonId, lessonId)).all();
  db.delete(schema.lessons).where(eq(schema.lessons.id, lessonId)).run();
  for (const img of images) {
    await deleteKey(img.storageKey);
    await deleteKey(img.webKey);
    await deleteKey(img.thumbKey);
  }
  revalidatePath("/admin/lessons");
  revalidatePath("/units");
  redirect("/admin/lessons");
}

export async function reorderLessonsAction(unitId: number, orderedIds: number[]) {
  await assertOwner();
  const db = getDb();
  db.transaction((t) => {
    orderedIds.forEach((id, i) => {
      t.update(schema.lessons)
        .set({ position: i + 1, updatedAt: nowIso() })
        .where(and(eq(schema.lessons.id, id), eq(schema.lessons.unitId, unitId)))
        .run();
    });
  });
  revalidatePath(`/units/${unitId}`);
  revalidatePath("/admin/lessons");
}

/** A lesson may not be published with no images — students would see a blank page. */
export async function publishLessonAction(lessonId: number) {
  await assertOwner();
  const db = getDb();
  const images = db
    .select({ id: schema.lessonImages.id })
    .from(schema.lessonImages)
    .where(and(eq(schema.lessonImages.lessonId, lessonId), eq(schema.lessonImages.state, "ready")))
    .all();
  if (images.length === 0) throw new Error("no_images");

  const now = nowIso();
  db.update(schema.lessons)
    .set({ status: "published", publishedAt: now, updatedAt: now })
    .where(eq(schema.lessons.id, lessonId))
    .run();
  revalidatePath("/units");
  revalidatePath(`/admin/lessons/${lessonId}`);
  revalidatePath("/admin");
}

export async function unpublishLessonAction(lessonId: number) {
  await assertOwner();
  getDb()
    .update(schema.lessons)
    .set({ status: "draft", publishedAt: null, updatedAt: nowIso() })
    .where(eq(schema.lessons.id, lessonId))
    .run();
  revalidatePath("/units");
  revalidatePath(`/admin/lessons/${lessonId}`);
  revalidatePath("/admin");
}

/**
 * Marks the owner-designated final lesson of a unit. The unique partial index
 * makes "two last lessons" impossible, so any previous flag is cleared first.
 */
export async function setLastLessonAction(lessonId: number, unitId: number, isLast: boolean) {
  await assertOwner();
  const db = getDb();
  db.transaction((t) => {
    if (isLast) {
      t.update(schema.lessons)
        .set({ isLastInUnit: 0, updatedAt: nowIso() })
        .where(and(eq(schema.lessons.unitId, unitId), ne(schema.lessons.id, lessonId)))
        .run();
    }
    t.update(schema.lessons)
      .set({ isLastInUnit: isLast ? 1 : 0, updatedAt: nowIso() })
      .where(eq(schema.lessons.id, lessonId))
      .run();
  });
  revalidatePath(`/units/${unitId}`);
  revalidatePath(`/admin/lessons/${lessonId}`);
}

/* ── Lesson images ───────────────────────────────────────────────────────── */

export async function reorderImagesAction(lessonId: number, orderedIds: number[]) {
  await assertOwner();
  const db = getDb();
  db.transaction((t) => {
    orderedIds.forEach((id, i) => {
      t.update(schema.lessonImages)
        .set({ position: i + 1 })
        .where(and(eq(schema.lessonImages.id, id), eq(schema.lessonImages.lessonId, lessonId)))
        .run();
    });
  });
  revalidatePath(`/admin/lessons/${lessonId}`);
  revalidatePath(`/lessons/${lessonId}`);
}

/** Deleting one image must never disturb the others: positions are compacted. */
export async function deleteImageAction(lessonId: number, imageId: number) {
  await assertOwner();
  const db = getDb();
  const img = db
    .select()
    .from(schema.lessonImages)
    .where(and(eq(schema.lessonImages.id, imageId), eq(schema.lessonImages.lessonId, lessonId)))
    .get();
  if (!img) return;

  db.delete(schema.lessonImages).where(eq(schema.lessonImages.id, imageId)).run();
  await deleteKey(img.storageKey);
  await deleteKey(img.webKey);
  await deleteKey(img.thumbKey);

  const rest = db
    .select({ id: schema.lessonImages.id })
    .from(schema.lessonImages)
    .where(eq(schema.lessonImages.lessonId, lessonId))
    .all();
  db.transaction((t) => {
    rest.forEach((r, i) => {
      t.update(schema.lessonImages).set({ position: i + 1 }).where(eq(schema.lessonImages.id, r.id)).run();
    });
  });

  // Editing content after a quiz exists must flag it stale, never silently
  // replace a published quiz.
  const quiz = db
    .select()
    .from(schema.quizzes)
    .where(and(eq(schema.quizzes.lessonId, lessonId), isNull(schema.quizzes.unitId)))
    .get();
  const now = nowIso();
  db.update(schema.lessons).set({ contentUpdatedAt: now, updatedAt: now }).where(eq(schema.lessons.id, lessonId)).run();
  if (quiz && quiz.status === "published") {
    db.update(schema.quizzes).set({ status: "stale", updatedAt: now }).where(eq(schema.quizzes.id, quiz.id)).run();
  }

  revalidatePath(`/admin/lessons/${lessonId}`);
  revalidatePath(`/lessons/${lessonId}`);
}
