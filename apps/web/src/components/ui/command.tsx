"use client";

/**
 * cmdk primitives from @mmo/ui. `CommandDialog` here keeps the legacy
 * composable shape (<CommandDialog><CommandInput/>…</CommandDialog>);
 * @mmo/ui's CommandDialog is items-driven and is a different API.
 */
import type * as React from "react";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandLoading,
    CommandSeparator,
    CommandShortcut,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@mmo/ui";
import { cn } from "@/lib/utils";

export interface CommandDialogProps extends React.ComponentProps<typeof Dialog> {
    title?: string;
    description?: string;
    className?: string;
    showCloseButton?: boolean;
    children?: React.ReactNode;
}

export function CommandDialog({ title = "Command Palette", description = "Search for a command to run...", children, className, showCloseButton = false, ...props }: CommandDialogProps) {
    return (
        <Dialog {...props}>
            <DialogHeader className="sr-only">
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <DialogContent className={cn("overflow-hidden p-0", className)} showCloseButton={showCloseButton} mobile="center">
                <Command className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
                    {children}
                </Command>
            </DialogContent>
        </Dialog>
    );
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator, CommandLoading };