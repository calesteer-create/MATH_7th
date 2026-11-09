"use client";

import { useTransition } from "react";
import { reorderUnitsAction, reorderLessonsAction } from "@/app/[locale]/admin/actions";

/**
 * Move up / move down rather than left / right arrows: vertical ordering is
 * unambiguous in both RTL and LTR and is reachable from the keyboard.
 */
export function ReorderRow({
  index,
  total,
  ids,
  action,
  unitId,
  upLabel,
  downLabel,
}: {
  index: number;
  total: number;
  ids: number[];
  action: "reorderUnits" | "reorderLessons";
  unitId?: number;
  upLabel: string;
  downLabel: string;
}) {
  const [pending, start] = useTransition();

  function move(delta: number) {
    const target = index + delta;
    if (target < 0 || target >= total) return;
    const next = [...ids];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    start(async () => {
      if (action === "reorderUnits") await reorderUnitsAction(next);
      else if (unitId !== undefined) await reorderLessonsAction(unitId, next);
    });
  }

  const btn =
    "grid size-7 place-items-center rounded-md border border-white/10 text-muted transition-colors " +
    "hover:text-mist disabled:opacity-25 disabled:pointer-events-none";

  return (
    <span className="flex shrink-0 flex-col gap-0.5">
      <button type="button" className={btn} disabled={index === 0 || pending} onClick={() => move(-1)} aria-label={upLabel}>
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 10l4-4 4 4" /></svg>
      </button>
      <button type="button" className={btn} disabled={index === total - 1 || pending} onClick={() => move(1)} aria-label={downLabel}>
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
      </button>
    </span>
  );
}
