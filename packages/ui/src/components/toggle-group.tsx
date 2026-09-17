"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { cn } from "../lib/cn.ts";

export const toggleVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent text-sm font-medium whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow] duration-(--dur-fast) ease-(--ease-out) select-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 data-pressed:bg-accent data-pressed:text-accent-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-border bg-background shadow-xs dark:border-input dark:bg-input/30",
      },
      size: {
        default: "h-control min-w-control px-2.5",
        sm: "h-control-sm min-w-control-sm px-2 text-xs",
        lg: "h-control-lg min-w-control-lg px-3 text-base",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ToggleVariants = VariantProps<typeof toggleVariants>;

const ToggleGroupContext = React.createContext<ToggleVariants>({});

export interface ToggleGroupProps<Value extends string = string> extends BaseToggleGroup.Props<Value>, ToggleVariants {}

/**
 * Group of toggle buttons. Set `multiple` for multi-select; supports `value`/`defaultValue`/`onValueChange` (arrays).
 * `variant`/`size` cascade to every `ToggleGroupItem`.
 */
export function ToggleGroup<Value extends string = string>({ className, variant = "default", size = "default", children, ...props }: ToggleGroupProps<Value>) {
  return (
    <BaseToggleGroup
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn(
        "group/toggle-group flex w-fit items-center rounded-md data-[orientation=vertical]:flex-col",
        variant === "outline" && "shadow-xs",
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
    </BaseToggleGroup>
  );
}

export interface ToggleGroupItemProps<Value extends string = string> extends BaseToggle.Props<Value>, ToggleVariants {}

/**
 * Toggle inside a `ToggleGroup`. Requires `value`. Inherits `variant`/`size` from the group unless overridden.
 */
export function ToggleGroupItem<Value extends string = string>({ className, variant, size, ...props }: ToggleGroupItemProps<Value>) {
  const ctx = React.useContext(ToggleGroupContext);
  const v = variant ?? ctx.variant ?? "default";
  const s = size ?? ctx.size ?? "default";
  return (
    <BaseToggle
      data-slot="toggle-group-item"
      data-variant={v}
      data-size={s}
      className={cn(
        toggleVariants({ variant: v, size: s }),
        "min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus-visible:z-10 focus:z-10",
        "group-data-[orientation=vertical]/toggle-group:first:rounded-t-md group-data-[orientation=vertical]/toggle-group:first:rounded-l-none group-data-[orientation=vertical]/toggle-group:last:rounded-b-md group-data-[orientation=vertical]/toggle-group:last:rounded-r-none",
        v === "outline" && "border-l-0 first:border-l group-data-[orientation=vertical]/toggle-group:border-l group-data-[orientation=vertical]/toggle-group:border-t-0 group-data-[orientation=vertical]/toggle-group:first:border-t",
        className,
      )}
      {...props}
    />
  );
}
