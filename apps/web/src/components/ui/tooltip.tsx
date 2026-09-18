"use client";

/**
 * Compat wrapper over @mmo/ui Tooltip (Base UI):
 * - TooltipTrigger accepts `asChild`
 * - TooltipProvider accepts Radix `delayDuration` (→ Base UI `delay`), default 0 like before
 */
import type * as React from "react";
import { Tooltip, TooltipContent, TooltipProvider as UiTooltipProvider, TooltipTrigger as UiTooltipTrigger } from "@mmo/ui";
import { withAsChild } from "./as-child";

type UiProviderProps = React.ComponentProps<typeof UiTooltipProvider>;
export interface TooltipProviderProps extends UiProviderProps {
    delayDuration?: number;
}

export function TooltipProvider({ delayDuration = 0, delay, ...props }: TooltipProviderProps) {
    return <UiTooltipProvider delay={delay ?? delayDuration} {...props} />;
}

export const TooltipTrigger = withAsChild<React.ComponentProps<typeof UiTooltipTrigger>>(UiTooltipTrigger, "TooltipTrigger");
export { Tooltip, TooltipContent };