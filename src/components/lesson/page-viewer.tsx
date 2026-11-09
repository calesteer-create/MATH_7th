"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatCount } from "@/lib/format";
import { cx } from "@/lib/utils";

export interface ViewerPage {
  id: number;
  /** Progressive pair: a tiny blurred placeholder, then the full page. */
  thumbSrc: string;
  src: string;
  width: number;
  height: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

/**
 * Textbook page reader.
 *
 * Built in-house rather than pulling in a viewer library: the only requirements
 * are zoom, pan, page stepping and touch, and a dependency here would be a
 * liability on low-end tablets. Zoom is transform-based so it stays on the
 * compositor and never re-decodes the image.
 */
export function PageViewer({ pages, dir }: { pages: ViewerPage[]; dir: "rtl" | "ltr" }) {
  const t = useTranslations("lesson");
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});

  const frameRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);

  const page = pages[index];
  const total = pages.length;

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= total) return;
      setIndex(next);
      resetView();
    },
    [total, resetView],
  );

  // Arrow keys follow the reading direction: in RTL "next" is the left arrow.
  const nextKey = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
  const prevKey = dir === "rtl" ? "ArrowRight" : "ArrowLeft";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === nextKey) goTo(index + 1);
      else if (e.key === prevKey) goTo(index - 1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(MAX_ZOOM, z * 1.3));
      else if (e.key === "-") setZoom((z) => Math.max(MIN_ZOOM, z / 1.3));
      else if (e.key === "0") resetView();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goTo, nextKey, prevKey, resetView]);

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return; // let normal page scrolling through
    e.preventDefault();
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.12 : 0.89))));
  }

  function onPointerDown(e: React.PointerEvent) {
    if (zoom <= 1) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }

  function onPointerUp() {
    setDragging(false);
  }

  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length !== 2) return;
    const [a, b] = [e.touches[0]!, e.touches[1]!];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!pinchStart.current) {
      pinchStart.current = { dist, zoom };
      return;
    }
    const scale = dist / pinchStart.current.dist;
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchStart.current.zoom * scale)));
  }

  function onTouchEnd() {
    pinchStart.current = null;
  }

  if (!page) return null;

  const toolBtn =
    "grid size-10 place-items-center rounded-xl border border-white/10 bg-ink-850/80 text-muted " +
    "transition-colors hover:border-brand-500/40 hover:text-mist disabled:opacity-40 disabled:pointer-events-none";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_180px]">
      <div>
        {/* Toolbar */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.3))} className={toolBtn} disabled={zoom <= MIN_ZOOM} aria-label={t("zoomOut")}>
              <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><circle cx="9" cy="9" r="6" /><path d="M6.5 9h5M13.5 13.5L17 17" /></svg>
            </button>
            <span aria-live="polite" className="bidi-isolate min-w-14 text-center text-sm font-semibold text-mist">
              {formatCount(Math.round(zoom * 100), dir === "rtl" ? "ar" : "en")}%
            </span>
            <button type="button" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.3))} className={toolBtn} disabled={zoom >= MAX_ZOOM} aria-label={t("zoomIn")}>
              <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><circle cx="9" cy="9" r="6" /><path d="M6.5 9h5M9 6.5v5M13.5 13.5L17 17" /></svg>
            </button>
            <button type="button" onClick={resetView} className={toolBtn} aria-label={t("resetZoom")}>
              <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M3 8V4h4M17 12v4h-4M4.5 13.5L3 17M15.5 6.5L17 3" /></svg>
            </button>
          </div>

          <span className="bidi-isolate ms-auto rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-muted">
            {t("pageIndicator", {
              current: formatCount(index + 1, dir === "rtl" ? "ar" : "en"),
              total: formatCount(total, dir === "rtl" ? "ar" : "en"),
            })}
          </span>
        </div>

        {/* Stage */}
        <div
          ref={frameRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className={cx(
            "relative overflow-hidden rounded-2xl border border-line bg-ink-950",
            "grid place-items-center touch-pan-y",
            zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
          )}
          style={{ minHeight: "60dvh" }}
        >
          {/* Neighbours are mounted so stepping pages is instant, but only the
              active page is decoded eagerly — the rest stay lazy. */}
          {pages.map((p, i) => {
            const active = i === index;
            const near = Math.abs(i - index) <= 1;
            return (
              <div
                key={p.id}
                aria-hidden={!active}
                className={cx(
                  "w-full transition-opacity duration-300",
                  active ? "relative opacity-100" : "pointer-events-none absolute inset-0 opacity-0",
                )}
              >
                <div
                  className="origin-center will-change-transform"
                  style={{
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                    transition: dragging ? "none" : "transform 180ms ease-out",
                  }}
                >
                  {!loaded[p.id] && near ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbSrc}
                      alt=""
                      aria-hidden
                      className="mx-auto w-full max-w-4xl blur-md"
                      style={{ aspectRatio: `${p.width} / ${p.height}` }}
                    />
                  ) : null}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.src}
                    alt={t("openFullscreen")}
                    loading={near ? "eager" : "lazy"}
                    decoding={active ? "auto" : "async"}
                    draggable={false}
                    onLoad={() => setLoaded((s) => ({ ...s, [p.id]: true }))}
                    className={cx(
                      "mx-auto w-full max-w-4xl select-none bg-white shadow-2xl transition-opacity duration-300",
                      loaded[p.id] ? "opacity-100" : "opacity-0",
                    )}
                    style={{ aspectRatio: `${p.width} / ${p.height}` }}
                  />
                </div>
              </div>
            );
          })}

          {/* Page stepping */}
          {total > 1 ? (
            <>
              <button
                type="button"
                onClick={() => goTo(index - 1)}
                disabled={index === 0}
                aria-label={t("prevPage")}
                className="absolute top-1/2 start-2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-ink-950/75 text-mist backdrop-blur transition-colors hover:bg-ink-900 disabled:opacity-25"
              >
                <svg viewBox="0 0 20 20" className="size-5 rtl:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M13 4l-6 6 6 6" /></svg>
              </button>
              <button
                type="button"
                onClick={() => goTo(index + 1)}
                disabled={index === total - 1}
                aria-label={t("nextPage")}
                className="absolute top-1/2 end-2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-ink-950/75 text-mist backdrop-blur transition-colors hover:bg-ink-900 disabled:opacity-25"
              >
                <svg viewBox="0 0 20 20" className="size-5 rtl:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M7 4l6 6-6 6" /></svg>
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* Page rail — vertical ordering, so it reads the same in RTL and LTR */}
      {total > 1 ? (
        <nav aria-label={t("pages")} className="order-first lg:order-last">
          <ol className="flex gap-2 overflow-x-auto pb-2 lg:max-h-[70dvh] lg:flex-col lg:overflow-y-auto lg:pe-1">
            {pages.map((p, i) => (
              <li key={p.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={i === index ? "true" : undefined}
                  aria-label={`${t("pages")} ${formatCount(i + 1, dir === "rtl" ? "ar" : "en")}`}
                  className={cx(
                    "block overflow-hidden rounded-lg border-2 transition-all",
                    i === index ? "border-brand-500" : "border-transparent opacity-55 hover:opacity-100",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumbSrc} alt="" className="h-24 w-auto lg:h-auto lg:w-full" loading="lazy" />
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
    </div>
  );
}
