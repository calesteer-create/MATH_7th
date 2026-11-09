import { and, asc, count, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Lesson, LessonImage, Unit } from "@/db/schema";

export interface UnitWithCount extends Unit {
  lessonCount: number;
}

export function listUnits(): UnitWithCount[] {
  const db = getDb();
  const rows = db
    .select({ unit: schema.units, lessonCount: count(schema.lessons.id) })
    .from(schema.units)
    .leftJoin(
      schema.lessons,
      and(eq(schema.lessons.unitId, schema.units.id), eq(schema.lessons.status, "published")),
    )
    .groupBy(schema.units.id)
    .orderBy(asc(schema.units.position))
    .all();
  return rows.map((r) => ({ ...r.unit, lessonCount: r.lessonCount }));
}

export function getUnit(unitId: number): Unit | undefined {
  return getDb().select().from(schema.units).where(eq(schema.units.id, unitId)).get();
}

export function listLessons(unitId: number, publishedOnly: boolean): Lesson[] {
  const db = getDb();
  const q = db
    .select()
    .from(schema.lessons)
    .where(
      publishedOnly
        ? and(eq(schema.lessons.unitId, unitId), eq(schema.lessons.status, "published"))
        : eq(schema.lessons.unitId, unitId),
    )
    .orderBy(asc(schema.lessons.position), asc(schema.lessons.id));
  return q.all();
}

export function getLesson(lessonId: number): Lesson | undefined {
  return getDb().select().from(schema.lessons).where(eq(schema.lessons.id, lessonId)).get();
}

export function getLessonWithUnit(
  lessonId: number,
): { lesson: Lesson; unit: Unit; siblings: Lesson[] } | undefined {
  const lesson = getLesson(lessonId);
  if (!lesson) return undefined;
  const unit = getUnit(lesson.unitId);
  if (!unit) return undefined;
  return { lesson, unit, siblings: listLessons(lesson.unitId, true) };
}

export function listLessonImages(lessonId: number): LessonImage[] {
  return getDb()
    .select()
    .from(schema.lessonImages)
    .where(and(eq(schema.lessonImages.lessonId, lessonId), eq(schema.lessonImages.state, "ready")))
    .orderBy(asc(schema.lessonImages.position))
    .all();
}

export function listAllLessonImages(lessonId: number): LessonImage[] {
  return getDb()
    .select()
    .from(schema.lessonImages)
    .where(eq(schema.lessonImages.lessonId, lessonId))
    .orderBy(asc(schema.lessonImages.position))
    .all();
}

export function getAllLessonImagesOrdered(): LessonImage[] {
  const db = getDb();
  const lessons = db
    .select({ id: schema.lessons.id, unitPosition: schema.units.position, position: schema.lessons.position })
    .from(schema.lessons)
    .innerJoin(schema.units, eq(schema.units.id, schema.lessons.unitId))
    .all();
  return db
    .select()
    .from(schema.lessonImages)
    .orderBy(asc(schema.lessonImages.position))
    .all()
    .filter((img) => lessons.some((l) => l.id === img.lessonId));
}

export interface OverviewStats {
  units: number;
  lessons: number;
  published: number;
  drafts: number;
  images: number;
}

export function overviewStats(): OverviewStats {
  const db = getDb();
  const scalar = (rows: Array<Record<string, unknown>>): number =>
    Number(Object.values(rows[0] ?? {})[0] ?? 0);

  const units = scalar(db.select({ n: count() }).from(schema.units).all());
  const lessons = scalar(db.select({ n: count() }).from(schema.lessons).all());
  const published = scalar(
    db.select({ n: count() }).from(schema.lessons).where(eq(schema.lessons.status, "published")).all(),
  );
  const drafts = scalar(
    db.select({ n: count() }).from(schema.lessons).where(eq(schema.lessons.status, "draft")).all(),
  );
  const images = scalar(db.select({ n: count() }).from(schema.lessonImages).all());
  return { units, lessons, published, drafts, images };
}

export function publishedLessonCount(): number {
  return overviewStats().published;
}

/** True when the unit's owner-designated final lesson exists and is published. */
export function unitIsComplete(unitId: number): boolean {
  const db = getDb();
  const row = db
    .select({ id: schema.lessons.id })
    .from(schema.lessons)
    .where(
      and(
        eq(schema.lessons.unitId, unitId),
        eq(schema.lessons.isLastInUnit, 1),
        eq(schema.lessons.status, "published"),
      ),
    )
    .get();
  return row !== undefined;
}

export function getQuizForLesson(lessonId: number) {
  return getDb()
    .select()
    .from(schema.quizzes)
    .where(and(eq(schema.quizzes.lessonId, lessonId), isNull(schema.quizzes.unitId)))
    .get();
}

export function getQuizForUnit(unitId: number) {
  return getDb()
    .select()
    .from(schema.quizzes)
    .where(and(eq(schema.quizzes.unitId, unitId), isNull(schema.quizzes.lessonId)))
    .get();
}
