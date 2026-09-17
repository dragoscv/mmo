"use client";

import { Toast as BaseToast } from "@base-ui/react/toast";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, XCircleIcon, XIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";

/** Wrap the app once; provides the toast manager to `useToast`. */
export const ToastProvider = BaseToast.Provider;
/** Returns `{ add, close, update, promise, toasts }` for the nearest ToastProvider. */
export const useToast = BaseToast.useToastManager;
/** Create a manager outside React (e.g. in a store) and pass it to `<ToastProvider toastManager>`. */
export const createToastManager = BaseToast.createToastManager;

export type ToastType = "success" | "error" | "warning" | "info";

const typeClass: Record<ToastType, string> = {
  success: "border-l-success",
  error: "border-l-destructive",
  warning: "border-l-warning",
  info: "border-l-info",
};

const typeIcon: Record<ToastType, typeof InfoIcon> = {
  success: CheckCircle2Icon,
  error: XCircleIcon,
  warning: AlertTriangleIcon,
  info: InfoIcon,
};

const typeIconClass: Record<ToastType, string> = {
  success: "text-success",
  error: "text-destructive",
  warning: "text-warning",
  info: "text-info",
};

function isToastType(type: string | undefined): type is ToastType {
  return type === "success" || type === "error" || type === "warning" || type === "info";
}

export interface ToastItemProps extends Omit<BaseToast.Root.Props, "toast"> {
  toast: BaseToast.Root.ToastObject;
}

/** Single toast card: coloured left border by `type`, title, description, optional action, close. */
export function ToastItem({ toast, className, ...props }: ToastItemProps) {
  const t = useUiT();
  const type = isToastType(toast.type) ? toast.type : undefined;
  const Icon = type ? typeIcon[type] : null;
  return (
    <BaseToast.Root
      toast={toast}
      data-slot="toast"
      data-type={type}
      className={cn(
        "surface pointer-events-auto absolute inset-x-0 mx-auto w-full rounded-lg border-l-4 p-4 text-popover-foreground",
        "[--gap:0.75rem] [--offset:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--gap)*-1+var(--toast-swipe-movement-y))]",
        "z-[calc(1000-var(--toast-index))] transition-[opacity,translate,scale] duration-(--dur-base) ease-(--ease-out)",
        "translate-x-(--toast-swipe-movement-x) translate-y-(--offset) scale-[calc(max(0,1-(var(--toast-index)*0.08)))]",
        "data-expanded:scale-100 data-[limited]:opacity-0",
        "data-starting-style:translate-y-[150%] data-starting-style:opacity-0",
        "data-ending-style:opacity-0 data-ending-style:data-[swipe-direction=down]:translate-y-[calc(var(--toast-swipe-movement-y)+150%)] data-ending-style:data-[swipe-direction=up]:translate-y-[calc(var(--toast-swipe-movement-y)-150%)] data-ending-style:data-[swipe-direction=left]:translate-x-[calc(var(--toast-swipe-movement-x)-150%)] data-ending-style:data-[swipe-direction=right]:translate-x-[calc(var(--toast-swipe-movement-x)+150%)]",
        "max-sm:bottom-auto max-sm:top-0 max-sm:data-starting-style:translate-y-[-150%] sm:bottom-0",
        type ? typeClass[type] : "border-l-border",
        className,
      )}
      {...props}
    >
      <BaseToast.Content className="flex items-start gap-3 pr-6">
        {Icon ? <Icon className={cn("mt-0.5 size-4 shrink-0", type ? typeIconClass[type] : "")} aria-hidden /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <BaseToast.Title data-slot="toast-title" className="text-sm leading-tight font-semibold" />
          <BaseToast.Description data-slot="toast-description" className="text-sm text-muted-foreground" />
          {toast.actionProps ? (
            <BaseToast.Action
              data-slot="toast-action"
              className="mt-1 w-fit text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/40 rounded-sm"
            />
          ) : null}
        </div>
      </BaseToast.Content>
      <BaseToast.Close
        data-slot="toast-close"
        aria-label={t("common.close")}
        className="absolute top-3 right-3 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        <XIcon className="size-3.5" />
      </BaseToast.Close>
    </BaseToast.Root>
  );
}

export interface ToasterProps extends Omit<BaseToast.Viewport.Props, "children"> {}

/** Renders the queued toasts. Bottom-right on desktop, top on mobile; respects safe areas. Place inside ToastProvider. */
export function Toaster({ className, ...props }: ToasterProps) {
  const { toasts } = useToast();
  return (
    <BaseToast.Portal>
      <BaseToast.Viewport
        data-slot="toaster"
        className={cn(
          "pointer-events-none fixed z-(--z-toast) flex w-[min(24rem,calc(100vw-2rem))] flex-col",
          "sm:right-[max(1rem,var(--safe-right,0px))] sm:bottom-[max(1rem,var(--safe-bottom))]",
          "max-sm:inset-x-0 max-sm:top-[max(1rem,var(--safe-top,0px))] max-sm:mx-auto",
          "h-(--toast-frontmost-height)",
          className,
        )}
        {...props}
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} swipeDirection={["down", "right", "up"]} />
        ))}
      </BaseToast.Viewport>
    </BaseToast.Portal>
  );
}
