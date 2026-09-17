"use client";

import { Separator as BaseSeparator } from "@base-ui/react/separator";
import { cn } from "../lib/cn.ts";

export interface SeparatorProps extends BaseSeparator.Props {
  /** When true (default) the separator is purely visual and hidden from AT. */
  decorative?: boolean;
}

/** Thin divider line, horizontal by default. */
export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: SeparatorProps) {
  return (
    <BaseSeparator
      data-slot="separator"
      orientation={orientation}
      role={decorative ? "none" : undefined}
      className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px self-stretch", className)}
      {...props}
    />
  );
}
