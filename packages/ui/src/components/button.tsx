"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap select-none outline-none transition-[background-color,border-color,color,box-shadow,translate,scale] duration-(--dur-fast) ease-(--ease-out) focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 motion-full:hover:shadow-glow",
        gradient: "bg-gradient-accent text-primary-foreground shadow-xs hover:brightness-110 motion-full:hover:shadow-glow",
        outline:
          "border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary",
        ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-control px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-control-sm gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 has-[>svg]:px-2",
        lg: "h-control-lg px-4 text-base has-[>svg]:px-3",
        icon: "size-control",
        "icon-xs": "size-6 rounded-[min(var(--radius-md),8px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-control-sm rounded-[min(var(--radius-md),10px)]",
        "icon-lg": "size-control-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children">,
    VariantProps<typeof buttonVariants>,
    Pick<useRender.ComponentProps<"button">, "render"> {
  children?: React.ReactNode;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

/**
 * Button. Use `render={<a href=… />}` (Base UI pattern) instead of Radix `asChild`.
 */
export function Button({ className, variant = "default", size = "default", loading = false, disabled, children, render, ...props }: ButtonProps) {
  const own: React.ComponentPropsWithoutRef<"button"> & Record<`data-${string}`, unknown> = {
    "data-slot": "button",
    "data-variant": variant,
    "data-size": size,
    "data-loading": loading || undefined,
    "aria-busy": loading || undefined,
    disabled: disabled || loading,
    className: cn(buttonVariants({ variant, size }), className),
    children: (
      <>
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </>
    ),
  };
  const element = useRender({
    render: render ?? <button type="button" />,
    props: mergeProps<"button">(own, props),
  });
  return element;
}
