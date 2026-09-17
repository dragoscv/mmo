"use client";

import * as React from "react";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn } from "../lib/cn";

export interface SliderProps<Value extends number | readonly number[] = number | readonly number[]> extends BaseSlider.Root.Props<Value> {
  /** Renders the formatted value(s) next to the control (no tooltip). */
  showValue?: boolean;
  /** Optional label text rendered above the control (wired via `Slider.Label`). */
  label?: React.ReactNode;
}

function thumbCount(value: unknown, defaultValue: unknown): number {
  const v = value ?? defaultValue;
  return Array.isArray(v) ? Math.max(1, v.length) : 1;
}

/**
 * Range slider. Supports single or multiple thumbs (array `value`/`defaultValue`),
 * `orientation`, `min`/`max`/`step` and `onValueChange`. Thumbs have a 44px hit area.
 */
export function Slider<Value extends number | readonly number[] = number | readonly number[]>({
  className,
  showValue = false,
  label,
  orientation = "horizontal",
  value,
  defaultValue,
  ...props
}: SliderProps<Value>) {
  const count = thumbCount(value, defaultValue);
  const vertical = orientation === "vertical";
  return (
    <BaseSlider.Root
      data-slot="slider"
      orientation={orientation}
      value={value}
      defaultValue={defaultValue}
      className={cn("flex gap-2 text-sm data-disabled:pointer-events-none data-disabled:opacity-50", vertical ? "h-full flex-row items-center" : "w-full flex-col", className)}
      {...(props as BaseSlider.Root.Props<Value>)}
    >
      {label || showValue ? (
        <div className={cn("flex items-center justify-between gap-2", vertical && "flex-col")}>
          {label ? <BaseSlider.Label className="font-medium text-foreground">{label}</BaseSlider.Label> : <span />}
          {showValue ? <BaseSlider.Value data-slot="slider-value" className="tabular-nums text-muted-foreground" /> : null}
        </div>
      ) : null}
      <BaseSlider.Control
        data-slot="slider-control"
        className={cn("relative flex touch-none items-center select-none", vertical ? "h-full w-11 flex-col justify-center" : "h-11 w-full")}
      >
        <BaseSlider.Track
          data-slot="slider-track"
          className={cn("relative grow overflow-hidden rounded-full bg-muted", vertical ? "h-full w-1.5" : "h-1.5 w-full")}
        >
          <BaseSlider.Indicator data-slot="slider-indicator" className="rounded-full bg-primary select-none" />
        </BaseSlider.Track>
        {Array.from({ length: count }, (_, i) => (
          <BaseSlider.Thumb
            key={i}
            index={i}
            data-slot="slider-thumb"
            className={cn(
              "relative block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm outline-none transition-[box-shadow,scale] duration-(--dur-fast) ease-(--ease-out)",
              "before:absolute before:inset-1/2 before:size-11 before:-translate-1/2 before:content-['']",
              "hover:ring-4 hover:ring-ring/30 data-dragging:scale-110 data-dragging:ring-4 data-dragging:ring-ring/40 focus-visible:ring-3 focus-visible:ring-ring/40",
            )}
          />
        ))}
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
