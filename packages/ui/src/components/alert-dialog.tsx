"use client";

import type * as React from "react";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "../lib/cn";
import { Button, type ButtonProps } from "./button";

/** Alert dialog root — a modal that requires an explicit response. */
export const AlertDialog = BaseAlertDialog.Root;
/** Button that opens the alert dialog. */
export const AlertDialogTrigger = BaseAlertDialog.Trigger;
/** Portal used by AlertDialogContent. */
export const AlertDialogPortal = BaseAlertDialog.Portal;

/** Dimmed backdrop behind the dialog. */
export function AlertDialogOverlay({ className, ...props }: BaseAlertDialog.Backdrop.Props) {
  return (
    <BaseAlertDialog.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 z-(--z-modal) min-h-dvh bg-black/50 backdrop-blur-[2px] transition-opacity duration-(--dur-base) data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      {...props}
    />
  );
}

export interface AlertDialogContentProps extends BaseAlertDialog.Popup.Props {
  size?: "sm" | "md" | "lg";
}

const sizes = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" };

/** Dialog surface: centred on desktop, bottom sheet on small screens. */
export function AlertDialogContent({ className, children, size = "md", ...props }: AlertDialogContentProps) {
  return (
    <BaseAlertDialog.Portal>
      <AlertDialogOverlay />
      <BaseAlertDialog.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "surface fixed z-(--z-modal) flex w-full flex-col gap-4 p-6 text-popover-foreground outline-none",
          "transition-[opacity,scale,translate] duration-(--dur-base) ease-(--ease-out)",
          "sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:data-starting-style:scale-95 sm:data-ending-style:scale-95 sm:data-starting-style:opacity-0 sm:data-ending-style:opacity-0",
          sizes[size],
          "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-2xl max-sm:pb-[max(1.5rem,var(--safe-bottom))] max-sm:data-starting-style:translate-y-full max-sm:data-ending-style:translate-y-full",
          className,
        )}
        {...props}
      >
        <div aria-hidden className="mx-auto -mt-2 mb-1 h-1 w-10 rounded-full bg-muted-foreground/40 sm:hidden" />
        {children}
      </BaseAlertDialog.Popup>
    </BaseAlertDialog.Portal>
  );
}

/** Title + description wrapper. */
export function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-dialog-header" className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)} {...props} />;
}

/** Action row; stacks on mobile, right-aligned on desktop. */
export function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

/** Accessible dialog title. */
export function AlertDialogTitle({ className, ...props }: BaseAlertDialog.Title.Props) {
  return <BaseAlertDialog.Title data-slot="alert-dialog-title" className={cn("font-heading text-lg leading-none font-semibold", className)} {...props} />;
}

/** Accessible dialog description. */
export function AlertDialogDescription({ className, ...props }: BaseAlertDialog.Description.Props) {
  return <BaseAlertDialog.Description data-slot="alert-dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

/** Confirming button; closes the dialog. Pass `variant="destructive"` for dangerous actions. */
export function AlertDialogAction({ variant = "default", ...props }: ButtonProps) {
  return <BaseAlertDialog.Close data-slot="alert-dialog-action" render={<Button variant={variant} {...props} />} />;
}

/** Cancel button; closes the dialog without acting. */
export function AlertDialogCancel({ variant = "outline", ...props }: ButtonProps) {
  return <BaseAlertDialog.Close data-slot="alert-dialog-cancel" render={<Button variant={variant} {...props} />} />;
}
