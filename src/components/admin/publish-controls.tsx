"use client";

import { useTransition } from "react";
import { publishLessonAction, unpublishLessonAction } from "@/app/[locale]/admin/actions";
import { buttonClass } from "@/components/ui/primitives";

export function PublishControls({
  lessonId,
  published,
  hasImages,
  labels,
}: {
  lessonId: number;
  published: boolean;
  hasImages: boolean;
  labels: { publish: string; unpublish: string; blocked: string };
}) {
  const [pending, start] = useTransition();

  if (published) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => unpublishLessonAction(lessonId))}
        className={buttonClass("secondary", "md")}
      >
        {labels.unpublish}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending || !hasImages}
        onClick={() => start(() => publishLessonAction(lessonId))}
        className={buttonClass("primary", "md")}
      >
        {labels.publish}
      </button>
      {!hasImages ? <span className="text-xs text-amber-300">{labels.blocked}</span> : null}
    </div>
  );
}
