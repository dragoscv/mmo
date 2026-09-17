"use client";

import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "../lib/cn";

export interface InputProps extends Omit<BaseInput.Props, "size"> {
  /** Density size; maps to the `h-control*` tokens. */
  size?: "sm" | "default" | "lg";
}

const sizes = { sm: "h-control-sm px-2.5 text-sm", default: "h-control px-3 text-sm", lg: "h-control-lg px-3.5 text-base" };

/**
 * Text input. Base UI `Input`, so it participates in `Field` validation automatically.
 */
export function Input({ className, size = "default", ...props }: InputProps) {
  return (
    <BaseInput
      data-slot="input"
      data-size={size}
      className={cn(
        "flex w-full min-w-0 rounded-md border border-input bg-background bg-clip-padding text-foreground shadow-xs outline-none transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out) dark:bg-input/30",
        "placeholder:text-muted-foreground file:inline-flex file:h-full file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground selection:bg-primary selection:text-primary-foreground",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[invalid]:border-destructive data-[invalid]:ring-3 data-[invalid]:ring-destructive/20",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
