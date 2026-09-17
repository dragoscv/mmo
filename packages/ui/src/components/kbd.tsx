import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { formatKeyParts, type Platform } from "../lib/shortcuts-registry";

export interface KbdProps extends ComponentProps<"kbd"> {
  size?: "sm" | "md";
}

/** Single key chip. */
export function Kbd({ className, size = "sm", ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex select-none items-center justify-center rounded-[min(var(--radius-md),6px)] border border-border bg-muted px-1.5 font-mono font-medium text-muted-foreground shadow-[inset_0_-1px_0_0_var(--color-border)]",
        size === "sm" ? "h-5 min-w-5 text-[0.6875rem]" : "h-6 min-w-6 text-xs",
        className,
      )}
      {...props}
    />
  );
}

export interface KbdComboProps extends Omit<ComponentProps<"span">, "children"> {
  /** e.g. `"mod+k"` */
  combo: string;
  platform?: Platform;
  size?: KbdProps["size"];
}

/** Renders every part of a combo (`⌘` `K`) as separate chips. */
export function KbdCombo({ combo, platform, size, className, ...props }: KbdComboProps) {
  const parts = formatKeyParts(combo, platform);
  return (
    <span data-slot="kbd-combo" className={cn("inline-flex items-center gap-0.5", className)} {...props}>
      {parts.map((p, i) => (
        <Kbd key={`${p}-${i}`} size={size}>
          {p}
        </Kbd>
      ))}
    </span>
  );
}
