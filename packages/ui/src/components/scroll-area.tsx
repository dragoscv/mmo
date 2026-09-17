"use client";

import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { cn } from "../lib/cn.ts";

export interface ScrollAreaProps extends BaseScrollArea.Root.Props {
  /** Which scrollbars to render. */
  orientation?: "vertical" | "horizontal" | "both";
  viewportClassName?: string;
}

/** Scrollable region with thin themed scrollbars that fade in on hover/scroll. */
export function ScrollArea({ className, children, orientation = "vertical", viewportClassName, ...props }: ScrollAreaProps) {
  return (
    <BaseScrollArea.Root data-slot="scroll-area" className={cn("relative overflow-hidden", className)} {...props}>
      <BaseScrollArea.Viewport data-slot="scroll-area-viewport" className={cn("size-full overscroll-contain rounded-[inherit] outline-none focus-visible:ring-3 focus-visible:ring-ring/40", viewportClassName)}>
        {children}
      </BaseScrollArea.Viewport>
      {orientation !== "horizontal" ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== "vertical" ? <ScrollBar orientation="horizontal" /> : null}
      <BaseScrollArea.Corner data-slot="scroll-area-corner" />
    </BaseScrollArea.Root>
  );
}

/** Themed scrollbar track + thumb; used by ScrollArea. */
export function ScrollBar({ className, orientation = "vertical", ...props }: BaseScrollArea.Scrollbar.Props) {
  return (
    <BaseScrollArea.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-px opacity-0 transition-opacity duration-(--dur-base) data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:duration-(--dur-fast) data-scrolling:duration-(--dur-fast)",
        orientation === "vertical" ? "absolute inset-y-0 right-0 w-2 flex-col" : "absolute inset-x-0 bottom-0 h-2 flex-row",
        className,
      )}
      {...props}
    >
      <BaseScrollArea.Thumb data-slot="scroll-area-thumb" className="relative flex-1 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/35" />
    </BaseScrollArea.Scrollbar>
  );
}
