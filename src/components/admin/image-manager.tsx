"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { DeleteImageButton } from "./delete-buttons";
import { reorderImagesAction } from "@/app/[locale]/admin/actions";
import { formatCount } from "@/lib/format";

export interface ManagedImage {
  id: number;
  thumbSrc: string;
  previewSrc: string;
}

interface Pending {
  name: string;
  progress: number;
  error?: string;
}

/**
 * Batch upload + ordering for one lesson.
 *
 * Files go straight to the server one at a time so a single bad file is reported
 * on its own and the rest of the batch still lands. Reordering is vertical
 * (move up / down) so it is unambiguous in RTL and LTR and keyboard-reachable.
 */
export function ImageManager({
  lessonId,
  images,
  locale,
  labels,
}: {
  lessonId: number;
  images: ManagedImage[];
  locale: "ar" | "en";
  labels: {
    upload: string;
    uploadHint: string;
    uploading: string;
    ready: string;
    failed: string;
    retry: string;
    preview: string;
    remove: string;
    moveUp: string;
    moveDown: string;
    noImages: string;
  };
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingList, setPendingList] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [, startReorder] = useTransition();

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const batch = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    setBusy(true);
    setPendingList(batch.map((f) => ({ name: f.name, progress: 0 })));

    let uploadedAny = false;
    for (let i = 0; i < batch.length; i += 1) {
      const file = batch[i]!;
      const form = new FormData();
      form.append("lessonId", String(lessonId));
      form.append("files", file);
      try {
        const res = await fetch("/api/admin/upload", { method: "POST", body: form });
        const body = (await res.json()) as {
          results?: Array<{ ok: boolean; error?: string }>;
          error?: string;
        };
        const result = body.results?.[0];
        if (res.ok && result?.ok) {
          uploadedAny = true;
          setPendingList((s) => s.map((p, idx) => (idx === i ? { ...p, progress: 100 } : p)));
        } else {
          setPendingList((s) =>
            s.map((p, idx) => (idx === i ? { ...p, progress: 100, error: result?.error ?? body.error ?? "failed" } : p)),
          );
        }
      } catch {
        setPendingList((s) => s.map((p, idx) => (idx === i ? { ...p, progress: 100, error: "network" } : p)));
      }
    }

    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (uploadedAny) {
      setPendingList([]);
      router.refresh();
    }
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= images.length) return;
    const next = images.map((i) => i.id);
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    startReorder(() => reorderImagesAction(lessonId, next));
  }

  const btn =
    "grid size-8 place-items-center rounded-lg border border-white/10 text-muted transition-colors hover:text-mist disabled:opacity-25 disabled:pointer-events-none";

  return (
    <div className="space-y-4">
      <label
        className="block cursor-pointer rounded-2xl border border-dashed border-line bg-white/[0.02] p-6 text-center transition-colors hover:border-brand-500/40"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy}
          onChange={(e) => void upload(e.target.files)}
          className="sr-only"
        />
        <span className="block text-sm font-medium text-mist">{busy ? labels.uploading : labels.upload}</span>
        <span className="mt-1 block text-xs text-faint">{labels.uploadHint}</span>
      </label>

      {pendingList.length > 0 ? (
        <ul className="grid gap-1.5">
          {pendingList.map((p) => (
            <li key={p.name} className="flex items-center gap-3 rounded-lg border border-line-soft px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted">{p.name}</span>
              {p.error ? (
                <span className="text-rose-300">
                  {labels.failed}: <span className="bidi-isolate">{p.error}</span>
                </span>
              ) : (
                <span className="text-brand-300">{labels.uploading}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {images.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-5 text-center text-sm text-faint">
          {labels.noImages}
        </p>
      ) : (
        <ol className="grid gap-2">
          {images.map((img, i) => (
            <li key={img.id} className="card-surface flex items-center gap-3 rounded-xl p-2.5">
              <span className="flex shrink-0 flex-col gap-0.5">
                <button type="button" className={btn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={labels.moveUp}>
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 10l4-4 4 4" /></svg>
                </button>
                <button type="button" className={btn} disabled={i === images.length - 1} onClick={() => move(i, 1)} aria-label={labels.moveDown}>
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
                </button>
              </span>

              <span className="bidi-isolate w-7 shrink-0 text-center text-xs font-bold text-faint">
                {formatCount(i + 1, locale)}
              </span>

              <a href={img.previewSrc} target="_blank" rel="noreferrer" className="block shrink-0 overflow-hidden rounded-md">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.thumbSrc} alt={labels.preview} className="h-16 w-auto" loading="lazy" />
              </a>

              <span className="min-w-0 flex-1 truncate text-xs text-muted">{labels.ready}</span>

              <a
                href={img.previewSrc}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-muted transition-colors hover:text-mist"
              >
                {labels.preview}
              </a>
              <DeleteImageButton lessonId={lessonId} imageId={img.id} label={labels.remove} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
