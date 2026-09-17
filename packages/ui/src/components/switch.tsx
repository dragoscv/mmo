"use client";

import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "../lib/cn";

export interface SwitchProps extends BaseSwitch.Root.Props {
  size?: "sm" | "default";
}

const roots = { sm: "h-4 w-7", default: "h-5 w-9" };
const thumbs = { sm: "size-3 data-checked:translate-x-3", default: "size-4 data-checked:translate-x-4" };

/**
 * On/off switch. Supports `checked`/`defaultChecked`/`onCheckedChange`.
 * The track is small; the hit area is padded to ≥44px on touch devices.
 */
export function Switch({ className, size = "default", ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input p-0.5 shadow-xs outline-none transition-[background-color,box-shadow] duration-(--dur-fast) ease-(--ease-out) dark:bg-input/60",
        "before:absolute before:inset-1/2 before:size-11 before:-translate-1/2 before:content-[''] pointer-coarse:before:block before:hidden",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
        "data-checked:bg-primary",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        "data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
        roots[size],
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background shadow-sm ring-0 transition-[translate,background-color] duration-(--dur-fast) ease-(--ease-out) data-checked:bg-primary-foreground",
          thumbs[size],
        )}
      />
    </BaseSwitch.Root>
  );
}
