import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

export type ContentWidth = "sm" | "md" | "lg" | "xl" | "full";

export interface PageProps extends ComponentProps<"div"> {
  /** Max reading width; `full` for DAW/mixer canvases. Ultra-wide screens never exceed `xl`. */
  width?: ContentWidth;
  /** Remove default padding (for edge-to-edge canvases). */
  bleed?: boolean;
}

/**
 * Page container. Centres content, applies the responsive gutter and the
 * safe-area bottom padding so the mobile tab bar / player never overlaps.
 */
export function Page({ width = "lg", bleed = false, className, ...props }: PageProps) {
  return (
    <div
      data-slot="page"
      data-width={width}
      className={cn(
        "@container/page w-full",
        width !== "full" && `content-${width}`,
        !bleed && "px-4 py-6 sm:px-6 lg:px-8 lg:py-8 pb-safe-6",
        className,
      )}
      {...props}
    />
  );
}

export interface PageHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (buttons, filters). Wraps under the title on narrow widths. */
  actions?: ReactNode;
  /** Breadcrumb or eyebrow rendered above the title. */
  eyebrow?: ReactNode;
}

export function PageHeader({ title, description, actions, eyebrow, className, ...props }: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn("mb-6 flex flex-col gap-4 @3xl/page:flex-row @3xl/page:items-end @3xl/page:justify-between", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</div> : null}
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
        {description ? <p className="max-w-prose text-sm text-muted-foreground text-pretty sm:text-base">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PageSection({ title, description, actions, className, children, ...props }: PageHeaderProps & { children?: ReactNode }) {
  return (
    <section data-slot="page-section" className={cn("flex flex-col gap-4", className)} {...props}>
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-heading text-lg font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
