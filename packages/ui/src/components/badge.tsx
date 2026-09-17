"use client";

import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";
import { cn } from "../lib/cn";

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-xs font-medium transition-[color,background-color,border-color] duration-(--dur-fast) focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        destructive: "bg-destructive/15 text-destructive",
        success: "bg-success/15 text-success",
        warning: "bg-warning/15 text-warning",
        info: "bg-info/15 text-info",
        gradient: "bg-gradient-accent text-primary-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children">,
    VariantProps<typeof badgeVariants>,
    Pick<useRender.ComponentProps<"span">, "render"> {
  children?: React.ReactNode;
}

/** Small status pill. Use `render={<a href=… />}` to change the element. */
export function Badge({ className, variant = "default", children, render, ...props }: BadgeProps) {
  const own: React.ComponentPropsWithoutRef<"span"> & Record<`data-${string}`, unknown> = {
    "data-slot": "badge",
    "data-variant": variant,
    className: cn(badgeVariants({ variant }), className),
    children,
  };
  return useRender({
    render: render ?? <span />,
    props: mergeProps<"span">(own, props),
  });
}
