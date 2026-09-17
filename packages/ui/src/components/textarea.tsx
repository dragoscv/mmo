"use client";

import * as React from "react";
import { Field as BaseField } from "@base-ui/react/field";
import { cn } from "../lib/cn.ts";

export interface TextareaProps extends Omit<BaseField.Control.Props, "render"> {
  /** Native textarea attributes not present on the generic control props. */
  rows?: number;
  cols?: number;
  wrap?: React.ComponentProps<"textarea">["wrap"];
}

/**
 * Multi-line text input. Rendered through `Field.Control` so it participates in `Field` validation.
 */
export function Textarea({ className, rows, cols, wrap, ...props }: TextareaProps) {
  return (
    <BaseField.Control
      data-slot="textarea"
      render={<textarea rows={rows} cols={cols} wrap={wrap} />}
      className={cn(
        "flex field-sizing-content min-h-[calc(var(--spacing-control)*2)] w-full min-w-0 rounded-md border border-input bg-background bg-clip-padding px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out) dark:bg-input/30",
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[invalid]:border-destructive data-[invalid]:ring-3 data-[invalid]:ring-destructive/20",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
