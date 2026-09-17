import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" aria-hidden className={cn("skeleton", className)} {...props} />;
}

/** Text-shaped skeleton: N lines, last one shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** Card-shaped skeleton matching <Card> paddings. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("surface rounded-xl p-6", className)} aria-hidden>
      <Skeleton className="mb-4 h-5 w-1/3" />
      <SkeletonText lines={3} />
    </div>
  );
}

/** Table-shaped skeleton: header + rows. */
export function SkeletonTable({ rows = 8, cols = 5, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)} aria-hidden>
      <div className="grid gap-3 px-3 py-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 w-2/3" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid h-row items-center gap-3 px-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn("h-3.5", c === 0 ? "w-full" : "w-3/4")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Media grid skeleton (posters / album art). */
export function SkeletonGrid({ count = 12, aspect = "aspect-square", className }: { count?: number; aspect?: string; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4", className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className={cn("w-full rounded-lg", aspect)} />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
