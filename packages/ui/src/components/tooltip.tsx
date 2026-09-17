"use client";

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "../lib/cn.ts";

export const TooltipProvider = BaseTooltip.Provider;
export const Tooltip = BaseTooltip.Root;
export const TooltipTrigger = BaseTooltip.Trigger;

export interface TooltipContentProps extends BaseTooltip.Popup.Props {
  side?: BaseTooltip.Positioner.Props["side"];
  sideOffset?: number;
  align?: BaseTooltip.Positioner.Props["align"];
}

export function TooltipContent({ className, side = "top", sideOffset = 6, align = "center", children, ...props }: TooltipContentProps) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner side={side} sideOffset={sideOffset} align={align} className="z-(--z-tooltip)">
        <BaseTooltip.Popup
          data-slot="tooltip-content"
          className={cn(
            "origin-(--transform-origin) rounded-md bg-foreground px-2.5 py-1.5 text-xs text-balance text-background shadow-md",
            "transition-[opacity,scale] duration-(--dur-fast) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
          <BaseTooltip.Arrow className="data-[side=bottom]:top-[-6px] data-[side=left]:right-[-9px] data-[side=left]:rotate-90 data-[side=right]:left-[-9px] data-[side=right]:-rotate-90 data-[side=top]:bottom-[-6px] data-[side=top]:rotate-180">
            <svg width="12" height="6" viewBox="0 0 12 6" className="fill-foreground" aria-hidden>
              <path d="M0 6 L6 0 L12 6 Z" />
            </svg>
          </BaseTooltip.Arrow>
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
