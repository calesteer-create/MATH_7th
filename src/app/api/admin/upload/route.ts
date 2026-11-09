import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/lib/auth";
import { ACCEPTED_MIME, MAX_UPLOAD_BYTES, storeLessonImage } from "@/lib/images";
import { nowIso } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface FileResult {
  name: string;
  ok: boolean;
  imageId?: number;
  position?: number;
  error?: string;
}

/**
 * Batch upload for one lesson.
 *
 * Each file is handled independently: one oversized or non-image file is
 * reported on its own and never fails the rest of the batch.
 */
export async function POST(req: Request) {
  // getSessionUser() already verifies the signed cookie and returns the username.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const lessonId = Number(form.get("lessonId"));
  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const db = getDb();
  const lesson = db.select().from(schema.lessons).where(eq(schema.lessons.id, lessonId)).get();
  if (!lesson) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const entries = form.getAll("files").filter((f): f is File => f instanceof File);
  if (entries.length === 0) {
    return NextResponse.json({ error: "no_files" }, { status: 400 });
  }

  // Deterministic order by file name so the owner's own naming decides sequence.
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

  let position = db
    .select({ p: schema.lessonImages.position })
    .from(schema.lessonImages)
    .where(eq(schema.lessonImages.lessonId, lessonId))
    .all()
    .reduce((m, r) => Math.max(m, r.p), 0);

  const results: FileResult[] = [];
  for (const file of sorted) {
    try {
      if (file.size > MAX_UPLOAD_BYTES) {
        results.push({ name: file.name, ok: false, error: "too_large" });
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const stored = await storeLessonImage(buffer, lessonId);
      if (!ACCEPTED_MIME.includes(stored.mime)) {
        results.push({ name: file.name, ok: false, error: "unsupported_format" });
        continue;
      }
      position += 1;
      const info = db
        .insert(schema.lessonImages)
        .values({
          lessonId,
          position,
          storageKey: stored.storageKey,
          webKey: stored.webKey,
          thumbKey: stored.thumbKey,
          mime: stored.mime,
          width: stored.width,
          height: stored.height,
          bytes: stored.bytes,
          sha256: stored.sha256,
          state: "ready",
          createdAt: nowIso(),
        })
        .run();

      // Any content change bumps contentUpdatedAt — this is what lets a quiz be
      // flagged stale instead of silently disagreeing with the lesson.
      const now = nowIso();
      db.update(schema.lessons).set({ contentUpdatedAt: now, updatedAt: now }).where(eq(schema.lessons.id, lessonId)).run();

      results.push({ name: file.name, ok: true, imageId: Number(info.lastInsertRowid), position });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      results.push({ name: file.name, ok: false, error: message });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  return NextResponse.json(
    { uploaded: ok, failed: results.length - ok, results },
    { status: ok > 0 ? 200 : 422 },
  );
}
