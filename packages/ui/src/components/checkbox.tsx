"use client";

import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "../lib/cn.ts";

export type CheckboxProps = BaseCheckbox.Root.Props;

/**
 * Checkbox. Supports `checked`/`defaultChecked`/`onCheckedChange` and `indeterminate`.
 * The visual box is 16px; the hit area is padded to ≥44px on touch devices.
 */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      data-slot="checkbox"
      className={cn(
        "peer relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[min(var(--radius-md),6px)] border border-input bg-background bg-clip-padding shadow-xs outline-none transition-[background-color,border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out) dark:bg-input/30",
        // ≥44px touch target without growing the visual box
        "before:absolute before:inset-1/2 before:size-11 before:-translate-1/2 before:content-[''] pointer-coarse:before:block before:hidden",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[invalid]:border-destructive",
        "data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator
        data-slot="checkbox-indicator"
        keepMounted
        className="flex items-center justify-center text-current transition-[opacity,scale] duration-(--dur-fast) data-unchecked:scale-75 data-unchecked:opacity-0 [&_svg]:size-3.5 [&_svg]:stroke-[3]"
        render={(renderProps, state) => (
          <span {...renderProps}>{state.indeterminate ? <MinusIcon aria-hidden /> : <CheckIcon aria-hidden />}</span>
        )}
      />
    </BaseCheckbox.Root>
  );
}
