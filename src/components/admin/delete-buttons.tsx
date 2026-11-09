"use client";

import { useTransition } from "react";
import { deleteUnitAction, deleteLessonAction, deleteImageAction } from "@/app/[locale]/admin/actions";
import { buttonClass } from "@/components/ui/primitives";

export function DeleteUnitButton({ unitId, label, confirm }: { unitId: number; label: string; confirm: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (window.confirm(confirm)) start(() => deleteUnitAction(unitId));
      }}
      className={buttonClass("danger", "md")}
    >
      {label}
    </button>
  );
}

export function DeleteLessonButton({ lessonId, label, confirm }: { lessonId: number; label: string; confirm: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (window.confirm(confirm)) start(() => deleteLessonAction(lessonId));
      }}
      className={buttonClass("danger", "md")}
    >
      {label}
    </button>
  );
}

export function DeleteImageButton({
  lessonId,
  imageId,
  label,
}: {
  lessonId: number;
  imageId: number;
  label: string;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={label}
      onClick={() => start(() => deleteImageAction(lessonId, imageId))}
      className="grid size-8 place-items-center rounded-lg border border-white/10 text-muted transition-colors hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
    >
      <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
        <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />
      </svg>
    </button>
  );
}
