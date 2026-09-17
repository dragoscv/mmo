"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { cn } from "../lib/cn";

/** Select root. Supports `value`/`defaultValue`/`onValueChange`, `multiple`, `name`. */
export const Select = BaseSelect.Root;
/** Select group wrapper (pair with `SelectLabel`). */
export const SelectGroup = BaseSelect.Group;
/** Renders the selected value (or `placeholder`). */
export const SelectValue = BaseSelect.Value;

export interface SelectTriggerProps extends BaseSelect.Trigger.Props {
  size?: "sm" | "default" | "lg";
}

const triggerSizes = { sm: "h-control-sm px-2.5 text-sm", default: "h-control px-3 text-sm", lg: "h-control-lg px-3.5 text-base" };

/**
 * Select trigger button. Shows a chevron that rotates while the popup is open.
 */
export function SelectTrigger({ className, size = "default", children, ...props }: SelectTriggerProps) {
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background bg-clip-padding text-foreground shadow-xs whitespace-nowrap outline-none transition-[border-color,box-shadow,background-color] duration-(--dur-fast) ease-(--ease-out) select-none dark:bg-input/30 dark:hover:bg-input/50",
        "data-placeholder:text-muted-foreground *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 data-popup-open:border-ring",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[invalid]:border-destructive",
        "data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        triggerSizes[size],
        className,
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="text-muted-foreground transition-transform duration-(--dur-fast) data-popup-open:rotate-180">
        <ChevronDownIcon aria-hidden />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export interface SelectContentProps extends BaseSelect.Popup.Props {
  side?: BaseSelect.Positioner.Props["side"];
  sideOffset?: number;
  align?: BaseSelect.Positioner.Props["align"];
  /** Align the selected item with the trigger (native-select feel). Default `false` for a dropdown feel. */
  alignItemWithTrigger?: boolean;
}

/**
 * Select popup. Portalled, positioned under the trigger, scroll arrows when the list overflows.
 */
export function SelectContent({ className, children, side = "bottom", sideOffset = 4, align = "start", alignItemWithTrigger = false, ...props }: SelectContentProps) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner side={side} sideOffset={sideOffset} align={align} alignItemWithTrigger={alignItemWithTrigger} className="z-(--z-popover) outline-none">
        <BaseSelect.Popup
          data-slot="select-content"
          className={cn(
            "surface min-w-(--anchor-width) max-h-(--available-height) origin-(--transform-origin) overflow-y-auto rounded-lg p-1 text-popover-foreground outline-none",
            "transition-[opacity,scale,translate] duration-(--dur-fast) ease-(--ease-out) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            className,
          )}
          {...props}
        >
          <BaseSelect.ScrollUpArrow className="sticky top-0 z-10 flex h-6 w-full cursor-default items-center justify-center bg-popover/90 text-muted-foreground">
            <ChevronUpIcon className="size-4" aria-hidden />
          </BaseSelect.ScrollUpArrow>
          <BaseSelect.List data-slot="select-list">{children}</BaseSelect.List>
          <BaseSelect.ScrollDownArrow className="sticky bottom-0 z-10 flex h-6 w-full cursor-default items-center justify-center bg-popover/90 text-muted-foreground">
            <ChevronDownIcon className="size-4" aria-hidden />
          </BaseSelect.ScrollDownArrow>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

/**
 * Select option. `children` is the visible text; a check mark shows when selected.
 */
export function SelectItem({ className, children, ...props }: BaseSelect.Item.Props) {
  return (
    <BaseSelect.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full min-h-control-sm cursor-default items-center gap-2 rounded-[min(var(--radius-md),8px)] py-1.5 pr-8 pl-2 text-sm outline-none select-none",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <BaseSelect.ItemText className="flex-1 truncate">{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
        <CheckIcon aria-hidden />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

/** Group heading inside a `SelectGroup`. */
export function SelectLabel({ className, ...props }: BaseSelect.GroupLabel.Props) {
  return <BaseSelect.GroupLabel data-slot="select-label" className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />;
}

/** Visual separator between groups/items. */
export function SelectSeparator({ className, ...props }: BaseSelect.Separator.Props) {
  return <BaseSelect.Separator data-slot="select-separator" className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)} {...props} />;
}
