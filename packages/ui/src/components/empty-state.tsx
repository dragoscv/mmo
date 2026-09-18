"use client";

import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, Inbox, Laptop, LockKeyhole, SearchX } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";
import { Skeleton } from "./skeleton";

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Primary + secondary actions. */
  actions?: ReactNode;
  /**
   * Decorative content rendered behind the card (e.g. `<GhostTable />`) so
   * the empty page previews its purpose. Non-interactive and hidden from AT.
   */
  backdrop?: ReactNode;
  /** `page` centres in the viewport; `inline` fits inside a card/list. */
  variant?: "page" | "inline";
  tone?: "neutral" | "error" | "warning";
}

/**
 * Skeleton rows shaped like a track list (cover, title/artist, duration pill).
 * Meant as an `EmptyState` backdrop; always `aria-hidden`.
 */
export function GhostTable({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div data-slot="ghost-table" className={cn("flex w-full flex-col gap-1", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid h-row grid-cols-[2.25rem_minmax(0,1fr)_3.5rem] items-center gap-3 px-3">
          <Skeleton className="size-9 rounded-md" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className={cn("h-3.5", i % 3 === 0 ? "w-1/2" : i % 3 === 1 ? "w-2/3" : "w-2/5")} />
            <Skeleton className={cn("h-3", i % 2 === 0 ? "w-1/3" : "w-1/4")} />
          </div>
          <Skeleton className="h-5 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * One empty/blocked-state component for every surface. Replaces the three
 * ad-hoc patterns in apps/web (`<p>Autentifică-te.</p>`, inline-style
 * fallbacks, NotSignedIn/NoCompanion cards).
 */
export function EmptyState({ icon, title, description, actions, backdrop, variant = "page", tone = "neutral", className, ...props }: EmptyStateProps) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      data-slot="empty-state"
      className={cn(
        "relative flex w-full items-center justify-center",
        variant === "page" ? "min-h-[60vh] p-6" : "p-4",
        className,
      )}
      {...props}
    >
      {backdrop ? (
        <div
          data-slot="empty-state-backdrop"
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden opacity-40 select-none [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
        >
          {backdrop}
        </div>
      ) : null}
      <div
        className={cn(
          "animate-rise-in relative flex w-full max-w-md flex-col items-center gap-4 text-center",
          variant === "page" && "surface rounded-2xl px-8 py-10",
        )}
      >
        {icon !== null && (
          <div
            className={cn(
              "flex size-14 items-center justify-center rounded-full [&_svg]:size-7",
              tone === "error" && "bg-destructive/10 text-destructive",
              tone === "warning" && "bg-warning/15 text-warning",
              tone === "neutral" && "bg-accent text-accent-foreground",
            )}
          >
            {icon ?? <Inbox aria-hidden />}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <h2 className="font-heading text-lg font-semibold text-balance">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground text-pretty">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{actions}</div> : null}
      </div>
    </div>
  );
}

// ─── Presets ────────────────────────────────────────────────────────────────

export function NotSignedInState({ action, ...rest }: { action: ReactNode } & Partial<EmptyStateProps>) {
  const t = useUiT();
  return <EmptyState icon={<LockKeyhole aria-hidden />} title={t("auth.required")} description={t("auth.requiredDetail")} actions={action} {...rest} />;
}

export function NoCompanionState({ actions, ...rest }: { actions: ReactNode } & Partial<EmptyStateProps>) {
  const t = useUiT();
  return <EmptyState icon={<Laptop aria-hidden />} title={t("companion.required")} description={t("companion.requiredDetail")} actions={actions} {...rest} />;
}

export function ErrorState({ onRetry, detail, ...rest }: { onRetry?: () => void; detail?: ReactNode } & Partial<EmptyStateProps>) {
  const t = useUiT();
  return (
    <EmptyState
      tone="error"
      icon={<AlertTriangle aria-hidden />}
      title={t("common.error")}
      description={detail ?? t("common.errorDetail")}
      actions={
        onRetry ? (
          <button type="button" onClick={onRetry} className="inline-flex h-control items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            {t("common.retry")}
          </button>
        ) : undefined
      }
      {...rest}
    />
  );
}

export function NoResultsState(props: Partial<EmptyStateProps>) {
  const t = useUiT();
  return <EmptyState variant="inline" icon={<SearchX aria-hidden />} title={t("common.noResults")} {...props} />;
}
