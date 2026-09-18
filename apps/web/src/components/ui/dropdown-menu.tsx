"use client";

/**
 * Compat wrapper over @mmo/ui DropdownMenu (Base UI):
 * - DropdownMenuTrigger accepts `asChild`
 * - DropdownMenuItem accepts Radix `onSelect` (→ `onClick`)
 * - DropdownMenuLabel works outside a Group (Base UI GroupLabel requires one)
 */
import type * as React from "react";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem as UiDropdownMenuItem,
    DropdownMenuLabel as UiDropdownMenuLabel,
    DropdownMenuPortal,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger as UiDropdownMenuTrigger,
    type DropdownMenuItemProps as UiDropdownMenuItemProps,
    type DropdownMenuLabelProps,
} from "@mmo/ui";
import { withAsChild } from "./as-child";

export const DropdownMenuTrigger = withAsChild<React.ComponentProps<typeof UiDropdownMenuTrigger>>(UiDropdownMenuTrigger, "DropdownMenuTrigger");

export interface DropdownMenuItemProps extends Omit<UiDropdownMenuItemProps, "onSelect"> {
    /** Radix-compat alias for `onClick`. */
    onSelect?: (event: Event) => void;
}

export function DropdownMenuItem({ onSelect, onClick, ...props }: DropdownMenuItemProps) {
    const handle: UiDropdownMenuItemProps["onClick"] = (e) => {
        onClick?.(e);
        onSelect?.(e.nativeEvent);
    };
    return <UiDropdownMenuItem onClick={onSelect || onClick ? handle : undefined} {...props} />;
}

export function DropdownMenuLabel(props: DropdownMenuLabelProps) {
    return (
        <DropdownMenuGroup>
            <UiDropdownMenuLabel {...props} />
        </DropdownMenuGroup>
    );
}

export {
    DropdownMenu,
    DropdownMenuPortal,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuCheckboxItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubTrigger,
    DropdownMenuSubContent,
};
