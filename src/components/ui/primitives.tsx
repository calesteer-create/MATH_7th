import type { ReactNode } from "react";
import { cx } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-500 text-ink-950 hover:bg-brand-400 shadow-[0_10px_30px_-12px_var(--color-brand-500)] font-semibold",
  secondary: "card-surface text-mist hover:border-brand-500/50 hover:text-white",
  ghost: "text-muted hover:text-mist hover:bg-white/5",
  danger: "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 border border-rose-500/30",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm rounded-lg gap-1.5",
  md: "h-11 px-5 text-sm rounded-xl gap-2",
  lg: "h-13 px-7 text-base rounded-xl gap-2.5",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md"): string {
  return cx(
    "inline-flex items-center justify-center transition-all duration-200 select-none",
    "disabled:opacity-45 disabled:pointer-events-none active:scale-[0.985]",
    VARIANTS[variant],
    SIZES[size],
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cx(buttonClass(variant, size), className)} {...rest}>
      {children}
    </button>
  );
}

export function Card({
  className,
  children,
  as: Tag = "div",
}: {
  className?: string;
  children: ReactNode;
  as?: "div" | "section" | "article" | "li";
}) {
  return <Tag className={cx("card-surface rounded-[var(--radius-card)]", className)}>{children}</Tag>;
}

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "brand" | "warn" | "danger" | "success";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "bg-white/5 text-muted border-white/10",
    brand: "bg-brand-500/12 text-brand-300 border-brand-500/30",
    warn: "bg-amber-400/12 text-amber-300 border-amber-400/30",
    danger: "bg-rose-500/12 text-rose-300 border-rose-500/30",
    success: "bg-emerald-500/12 text-emerald-300 border-emerald-500/30",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-surface rounded-[var(--radius-card)] px-6 py-14 text-center">
      <div
        aria-hidden
        className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.03] text-2xl text-muted"
      >
        ◇
      </div>
      <h2 className="text-lg font-semibold text-mist">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">{body}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-8">
      {eyebrow ? (
        <p className="mb-2 text-xs font-semibold text-brand-400">{eyebrow}</p>
      ) : null}
      <h1 className="text-balance text-3xl font-bold text-mist sm:text-4xl">{title}</h1>
      {subtitle ? <p className="mt-3 max-w-2xl text-base text-muted">{subtitle}</p> : null}
    </header>
  );
}

export const fieldClass =
  "w-full rounded-xl border border-white/10 bg-ink-900 px-3.5 py-2.5 text-sm text-mist " +
  "placeholder:text-faint transition-colors focus:border-brand-500/60 focus:outline-none";

export const labelClass = "mb-1.5 block text-sm font-medium text-muted";
