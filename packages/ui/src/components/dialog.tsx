"use client";

import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogPortal = BaseDialog.Portal;
export const DialogClose = BaseDialog.Close;

export function DialogOverlay({ className, ...props }: BaseDialog.Backdrop.Props) {
  return (
    <BaseDialog.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-(--z-modal) min-h-dvh bg-black/50 backdrop-blur-[2px] transition-opacity duration-(--dur-base) data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      {...props}
    />
  );
}

export interface DialogContentProps extends BaseDialog.Popup.Props {
  showCloseButton?: boolean;
  /** `sheet` slides up from the bottom on small screens (mobile-native feel). */
  mobile?: "center" | "sheet";
  size?: "sm" | "md" | "lg" | "xl" | "full";
}

const sizes = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl", full: "sm:max-w-[calc(100vw-4rem)]" };

export function DialogContent({ className, children, showCloseButton = true, mobile = "sheet", size = "md", ...props }: DialogContentProps) {
  const t = useUiT();
  return (
    <DialogPortal>
      <DialogOverlay />
      <BaseDialog.Popup
        data-slot="dialog-content"
        className={cn(
          "surface fixed z-(--z-modal) flex w-full flex-col gap-4 p-6 text-popover-foreground outline-none",
          "transition-[opacity,scale,translate] duration-(--dur-base) ease-(--ease-out)",
          // desktop: centred
          "sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:data-starting-style:scale-95 sm:data-ending-style:scale-95 sm:data-starting-style:opacity-0 sm:data-ending-style:opacity-0",
          sizes[size],
          mobile === "sheet"
            ? "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-2xl max-sm:pb-[max(1.5rem,var(--safe-bottom))] max-sm:data-starting-style:translate-y-full max-sm:data-ending-style:translate-y-full"
            : "max-sm:top-1/2 max-sm:left-1/2 max-sm:w-[calc(100vw-2rem)] max-sm:-translate-x-1/2 max-sm:-translate-y-1/2 max-sm:rounded-2xl max-sm:data-starting-style:opacity-0 max-sm:data-ending-style:opacity-0",
          className,
        )}
        {...props}
      >
        {mobile === "sheet" ? <div aria-hidden className="mx-auto -mt-2 mb-1 h-1 w-10 rounded-full bg-muted-foreground/40 sm:hidden" /> : null}
        {children}
        {showCloseButton ? (
          <BaseDialog.Close
            data-slot="dialog-close"
            aria-label={t("common.close")}
            className="absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <XIcon className="size-4" />
          </BaseDialog.Close>
        ) : null}
      </BaseDialog.Popup>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: BaseDialog.Title.Props) {
  return <BaseDialog.Title data-slot="dialog-title" className={cn("font-heading text-lg leading-none font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: BaseDialog.Description.Props) {
  return <BaseDialog.Description data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
