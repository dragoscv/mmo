"use client";

import * as React from "react";
import { cn } from "../lib/cn.ts";

export type LabelProps = React.ComponentProps<"label">;

/**
 * Standalone form label. Inside a `Field`, prefer `FieldLabel` (auto-wired `htmlFor`).
 */
export function Label({ className, ...props }: LabelProps) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium text-foreground select-none",
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
