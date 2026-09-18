"use client";

/**
 * Compat wrapper over @mmo/ui Dialog (Base UI):
 * - DialogTrigger accepts `asChild`
 * - DialogContent accepts legacy `overlayClassName` (ignored: the overlay is owned by @mmo/ui)
 *   and defaults to `mobile="center"` to preserve previous centred behaviour
 * - DialogFooter accepts legacy `showCloseButton`
 */
import type * as React from "react";
import { useTranslations } from "next-intl";
import {
    Dialog,
    DialogClose,
    DialogContent as UiDialogContent,
    DialogDescription,
    DialogFooter as UiDialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger as UiDialogTrigger,
    type DialogContentProps as UiDialogContentProps,
} from "@mmo/ui";
import { Button } from "./button";
import { withAsChild } from "./as-child";

export const DialogTrigger = withAsChild<React.ComponentProps<typeof UiDialogTrigger>>(UiDialogTrigger, "DialogTrigger");

export interface DialogContentProps extends UiDialogContentProps {
    /** @deprecated no-op; overlay z-index comes from `--z-modal`. */
    overlayClassName?: string;
}

export function DialogContent({ overlayClassName: _overlay, mobile = "center", ...props }: DialogContentProps) {
    void _overlay;
    return <UiDialogContent mobile={mobile} {...props} />;
}

export interface DialogFooterProps extends React.ComponentProps<"div"> {
    showCloseButton?: boolean;
}

export function DialogFooter({ showCloseButton = false, children, ...props }: DialogFooterProps) {
    const t = useTranslations("common");
    return (
        <UiDialogFooter {...props}>
            {children}
            {showCloseButton ? (
                <DialogClose render={<Button variant="outline" />}>{t("close")}</DialogClose>
            ) : null}
        </UiDialogFooter>
    );
}

export { Dialog, DialogClose, DialogDescription, DialogHeader, DialogOverlay, DialogPortal, DialogTitle };