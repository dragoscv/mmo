"use client";

/**
 * Compat wrapper over @mmo/ui ContextMenu (Base UI):
 * - ContextMenuTrigger accepts `asChild`
 * - ContextMenuItem accepts Radix `onSelect` (→ `onClick`)
 * - ContextMenuLabel works outside a Group
 */
import type * as React from "react";
import {
    ContextMenu,
    ContextMenuCheckboxItem,
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem as UiContextMenuItem,
    ContextMenuLabel as UiContextMenuLabel,
    ContextMenuPortal,
    ContextMenuRadioGroup,
    ContextMenuRadioItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger as UiContextMenuTrigger,
    type ContextMenuItemProps as UiContextMenuItemProps,
    type ContextMenuLabelProps,
} from "@mmo/ui";
import { withAsChild } from "./as-child";

export const ContextMenuTrigger = withAsChild<React.ComponentProps<typeof UiContextMenuTrigger>>(UiContextMenuTrigger, "ContextMenuTrigger");

export interface ContextMenuItemProps extends Omit<UiContextMenuItemProps, "onSelect"> {
    /** Radix-compat alias for `onClick`. */
    onSelect?: (event: Event) => void;
}

export function ContextMenuItem({ onSelect, onClick, ...props }: ContextMenuItemProps) {
    const handle: UiContextMenuItemProps["onClick"] = (e) => {
        onClick?.(e);
        onSelect?.(e.nativeEvent);
    };
    return <UiContextMenuItem onClick={onSelect || onClick ? handle : undefined} {...props} />;
}

export function ContextMenuLabel(props: ContextMenuLabelProps) {
    return (
        <ContextMenuGroup>
            <UiContextMenuLabel {...props} />
        </ContextMenuGroup>
    );
}

export {
    ContextMenu,
    ContextMenuContent,
    ContextMenuCheckboxItem,
    ContextMenuRadioItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuGroup,
    ContextMenuPortal,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuRadioGroup,
};