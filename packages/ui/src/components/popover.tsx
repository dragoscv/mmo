"use client";

import type * as React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { cn } from "../lib/cn.ts";

/** Popover root — controls open state. */
export const Popover = BasePopover.Root;
/** Element that toggles the popover. */
export const PopoverTrigger = BasePopover.Trigger;
/** Portal for popover content (used internally by PopoverContent). */
export const PopoverPortal = BasePopover.Portal;
/** Popover title (for accessible labelling). */
export const PopoverTitle = BasePopover.Title;
/** Popover description. */
export const PopoverDescription = BasePopover.Description;
/** Closes the popover when activated. */
export const PopoverClose = BasePopover.Close;

export interface PopoverContentProps extends BasePopover.Popup.Props {
  side?: BasePopover.Positioner.Props["side"];
  align?: BasePopover.Positioner.Props["align"];
  sideOffset?: number;
  alignOffset?: number;
  /** Explicit anchor element; defaults to the trigger. */
  anchor?: BasePopover.Positioner.Props["anchor"];
}

/** Positioned, animated popover surface. Accepts shadcn-style `side`/`align`/`sideOffset`. */
export function PopoverContent({ className, side = "bottom", align = "center", sideOffset = 6, alignOffset, anchor, ...props }: PopoverContentProps) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} alignOffset={alignOffset} anchor={anchor} className="z-(--z-popover)">
        <BasePopover.Popup
          data-slot="popover-content"
          className={cn(
            "surface w-72 origin-(--transform-origin) rounded-lg p-4 text-popover-foreground outline-none",
            "transition-[opacity,scale] duration-(--dur-fast) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            className,
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

export interface PopoverAnchorProps extends React.ComponentProps<"span"> {
  ref?: React.Ref<HTMLSpanElement>;
}

/**
 * Anchor marker for shadcn compatibility. Base UI positions relative to the trigger;
 * pass the ref of this element to `PopoverContent anchor={ref}` to anchor elsewhere.
 */
export function PopoverAnchor({ className, ...props }: PopoverAnchorProps) {
  return <span data-slot="popover-anchor" className={cn("contents", className)} {...props} />;
}
