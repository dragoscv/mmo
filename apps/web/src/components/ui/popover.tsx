"use client";

// Compat wrapper over @mmo/ui Popover (Base UI): `asChild` on trigger + legacy PopoverHeader.
import type * as React from "react";
import { cn } from "@/lib/utils";
import {
    Popover,
    PopoverAnchor,
    PopoverContent,
    PopoverDescription,
    PopoverTitle,
    PopoverClose,
    PopoverPortal,
    PopoverTrigger as UiPopoverTrigger,
} from "@mmo/ui";
import { withAsChild } from "./as-child";

export const PopoverTrigger = withAsChild<React.ComponentProps<typeof UiPopoverTrigger>>(UiPopoverTrigger, "PopoverTrigger");

export function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="popover-header" className={cn("flex flex-col gap-0.5 text-sm", className)} {...props} />;
}

export { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverTitle, PopoverClose, PopoverPortal };