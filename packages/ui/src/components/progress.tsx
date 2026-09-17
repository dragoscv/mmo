"use client";

import type * as React from "react";
import { Progress as BaseProgress } from "@base-ui/react/progress";
import { cn } from "../lib/cn";

export interface ProgressProps extends Omit<BaseProgress.Root.Props, "value"> {
  /** Current value; ignored when `indeterminate`. */
  value?: number | null;
  max?: number;
  /** Unknown duration — shows a moving shimmer instead of a fill. */
  indeterminate?: boolean;
  /** Render the formatted percentage to the right of the bar. */
  showValue?: boolean;
  trackClassName?: string;
  indicatorClassName?: string;
}

/** Linear progress bar. Pass `indeterminate` for unknown-length work. */
export function Progress({ className, value = 0, max = 100, indeterminate = false, showValue = false, trackClassName, indicatorClassName, ...props }: ProgressProps) {
  return (
    <BaseProgress.Root data-slot="progress" value={indeterminate ? null : value} max={max} className={cn("flex w-full items-center gap-3", className)} {...props}>
      <BaseProgress.Track data-slot="progress-track" className={cn("relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted", trackClassName)}>
        <BaseProgress.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full rounded-full bg-primary transition-[width] duration-(--dur-base) ease-(--ease-out)",
            indeterminate && "skeleton w-full bg-primary/40",
            indicatorClassName,
          )}
          style={indeterminate ? { width: "100%" } : undefined}
        />
      </BaseProgress.Track>
      {showValue && !indeterminate ? <BaseProgress.Value data-slot="progress-value" className="min-w-[3ch] text-right text-xs tabular-nums text-muted-foreground" /> : null}
    </BaseProgress.Root>
  );
}

export interface ProgressJobProps extends ProgressProps {
  /** Job name shown above the bar. */
  label: React.ReactNode;
  /** Optional ETA / status text shown below (e.g. "2 min left · 340/1200 files"). */
  eta?: React.ReactNode;
}

/** Labelled progress for long jobs (scans, downloads): label + % on top, optional ETA line below. */
export function ProgressJob({ label, eta, className, indeterminate, value, max = 100, ...props }: ProgressJobProps) {
  const pct = indeterminate || value == null ? null : Math.round((Math.min(Math.max(value, 0), max) / max) * 100);
  return (
    <div data-slot="progress-job" className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate font-medium">{label}</span>
        {pct != null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{pct}%</span> : null}
      </div>
      <Progress value={value} max={max} indeterminate={indeterminate} {...props} />
      {eta ? <div className="text-xs text-muted-foreground">{eta}</div> : null}
    </div>
  );
}
