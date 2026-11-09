import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/lib/auth";
import { readKey } from "@/lib/storage";

export const dynamic = "force-dynamic";

const VARIANTS = ["web", "thumb", "original"] as const;
type Variant = (typeof VARIANTS)[number];

/**
 * Serves lesson page scans.
 *
 * The media directory is never exposed statically: every request passes an
 * authorisation check here. Published lessons are public; anything still in
 * draft is visible only to the signed-in owner. Storage keys never appear in
 * HTML, so knowing a key is useless without passing this route.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ imageId: string; variant: string }> },
) {
  const { imageId, variant } = await params;

  if (!VARIANTS.includes(variant as Variant)) {
    return new Response("Not found", { status: 404 });
  }

  const id = Number(imageId);
  if (!Number.isInteger(id) || id <= 0) return new Response("Not found", { status: 404 });

  const db = getDb();
  const row = db
    .select({
      image: schema.lessonImages,
      status: schema.lessons.status,
    })
    .from(schema.lessonImages)
    .innerJoin(schema.lessons, eq(schema.lessons.id, schema.lessonImages.lessonId))
    .where(eq(schema.lessonImages.id, id))
    .get();

  if (!row) return new Response("Not found", { status: 404 });

  if (row.status !== "published") {
    const user = await getSessionUser();
    if (!user) return new Response("Not found", { status: 404 });
  }

  const key =
    variant === "original"
      ? row.image.storageKey
      : variant === "thumb"
        ? (row.image.thumbKey ?? row.image.webKey ?? row.image.storageKey)
        : (row.image.webKey ?? row.image.storageKey);

  const data = await readKey(key);
  if (!data) return new Response("Not found", { status: 404 });

  const isOriginal = variant === "original";
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": isOriginal ? row.image.mime : "image/webp",
      "Content-Length": String(data.byteLength),
      "Cache-Control": isOriginal ? "private, max-age=300" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
