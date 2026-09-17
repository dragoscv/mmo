"use client";

import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { cn } from "../lib/cn.ts";

/**
 * Radio group container. Supports `value`/`defaultValue`/`onValueChange`, `name`, `disabled`.
 */
export function RadioGroup<Value>({ className, ...props }: BaseRadioGroup.Props<Value>) {
  return <BaseRadioGroup data-slot="radio-group" className={cn("grid gap-3", className)} {...props} />;
}

/**
 * Single radio button. Visual circle is 16px; the hit area is padded to ≥44px on touch devices.
 */
export function RadioGroupItem<Value>({ className, ...props }: BaseRadio.Root.Props<Value>) {
  return (
    <BaseRadio.Root
      data-slot="radio-group-item"
      className={cn(
        "peer relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input bg-background bg-clip-padding text-primary shadow-xs outline-none transition-[border-color,box-shadow,background-color] duration-(--dur-fast) ease-(--ease-out) dark:bg-input/30",
        "before:absolute before:inset-1/2 before:size-11 before:-translate-1/2 before:content-[''] pointer-coarse:before:block before:hidden",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
        "data-checked:border-primary",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[invalid]:border-destructive",
        "data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseRadio.Indicator
        data-slot="radio-group-indicator"
        keepMounted
        className="flex size-2 rounded-full bg-primary transition-[opacity,scale] duration-(--dur-fast) data-unchecked:scale-50 data-unchecked:opacity-0"
      />
    </BaseRadio.Root>
  );
}
