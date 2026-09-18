"use client";

/**
 * Compat wrapper over @mmo/ui AlertDialog (Base UI):
 * - AlertDialogTrigger accepts `asChild`
 * - AlertDialogContent maps legacy size "default" → "md"
 * - AlertDialogMedia kept (no @mmo/ui equivalent)
 */
import type * as React from "react";
import { cn } from "@/lib/utils";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent as UiAlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogOverlay,
    AlertDialogPortal,
    AlertDialogTitle,
    AlertDialogTrigger as UiAlertDialogTrigger,
    type AlertDialogContentProps as UiAlertDialogContentProps,
} from "@mmo/ui";
import { withAsChild } from "./as-child";

export const AlertDialogTrigger = withAsChild<React.ComponentProps<typeof UiAlertDialogTrigger>>(UiAlertDialogTrigger, "AlertDialogTrigger");

export interface AlertDialogContentProps extends Omit<UiAlertDialogContentProps, "size"> {
    size?: UiAlertDialogContentProps["size"] | "default";
}

export function AlertDialogContent({ size = "md", ...props }: AlertDialogContentProps) {
    return <UiAlertDialogContent size={size === "default" ? "md" : size} {...props} />;
}

export function AlertDialogMedia({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="alert-dialog-media"
            className={cn("mb-2 inline-flex size-16 items-center justify-center rounded-md bg-muted sm:mb-0 [&_svg:not([class*='size-'])]:size-6", className)}
            {...props}
        />
    );
}

export {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogOverlay,
    AlertDialogPortal,
    AlertDialogTitle,
};