"use client";

import type * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { useUiT } from "../i18n/index.tsx";

/** Sheet root — a dialog that slides in from an edge. */
export const Sheet = BaseDialog.Root;
/** Button that opens the sheet. */
export const SheetTrigger = BaseDialog.Trigger;
/** Closes the sheet when activated. */
export const SheetClose = BaseDialog.Close;
/** Portal used by SheetContent. */
export const SheetPortal = BaseDialog.Portal;

/** Dimmed backdrop behind the sheet. */
export function SheetOverlay({ className, ...props }: BaseDialog.Backdrop.Props) {
  return (
    <BaseDialog.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-(--z-modal) min-h-dvh bg-black/50 backdrop-blur-[2px] transition-opacity duration-(--dur-base) data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      {...props}
    />
  );
}

export type SheetSide = "top" | "right" | "bottom" | "left";

export interface SheetContentProps extends BaseDialog.Popup.Props {
  side?: SheetSide;
  showCloseButton?: boolean;
}

const sideClass: Record<SheetSide, string> = {
  right: "inset-y-0 right-0 h-full w-3/4 max-w-sm border-l rounded-l-2xl data-starting-style:translate-x-full data-ending-style:translate-x-full",
  left: "inset-y-0 left-0 h-full w-3/4 max-w-sm border-r rounded-r-2xl data-starting-style:-translate-x-full data-ending-style:-translate-x-full",
  top: "inset-x-0 top-0 max-h-[92dvh] border-b rounded-b-2xl pt-[max(1.5rem,var(--safe-top,0px))] data-starting-style:-translate-y-full data-ending-style:-translate-y-full",
  bottom:
    "inset-x-0 bottom-0 max-h-[92dvh] border-t rounded-t-2xl pb-[max(1.5rem,var(--safe-bottom))] data-starting-style:translate-y-full data-ending-style:translate-y-full",
};

/** Sliding panel. `side` picks the edge; bottom sheets get a drag handle and safe-area padding. */
export function SheetContent({ className, children, side = "right", showCloseButton = true, ...props }: SheetContentProps) {
  const t = useUiT();
  return (
    <BaseDialog.Portal>
      <SheetOverlay />
      <BaseDialog.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "surface fixed z-(--z-modal) flex flex-col gap-4 overflow-y-auto p-6 text-popover-foreground outline-none",
          "transition-[translate,opacity] duration-(--dur-base) ease-(--ease-out)",
          sideClass[side],
          className,
        )}
        {...props}
      >
        {side === "bottom" ? <div aria-hidden className="mx-auto -mt-2 mb-1 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40" /> : null}
        {children}
        {showCloseButton ? (
          <BaseDialog.Close
            data-slot="sheet-close"
            aria-label={t("common.close")}
            className="absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <XIcon className="size-4" />
          </BaseDialog.Close>
        ) : null}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

/** Title + description wrapper. */
export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

/** Action row pinned to the end of the sheet. */
export function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

/** Accessible sheet title. */
export function SheetTitle({ className, ...props }: BaseDialog.Title.Props) {
  return <BaseDialog.Title data-slot="sheet-title" className={cn("font-heading text-lg leading-none font-semibold", className)} {...props} />;
}

/** Accessible sheet description. */
export function SheetDescription({ className, ...props }: BaseDialog.Description.Props) {
  return <BaseDialog.Description data-slot="sheet-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
