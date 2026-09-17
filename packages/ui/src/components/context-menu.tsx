"use client";

import type * as React from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { menuItemClass, menuItemDestructiveClass, menuPopupClass } from "./dropdown-menu";

/** Context menu root. */
export const ContextMenu = BaseContextMenu.Root;
/** Area that opens the menu on right-click / long-press. */
export const ContextMenuTrigger = BaseContextMenu.Trigger;
/** Portal used by ContextMenuContent. */
export const ContextMenuPortal = BaseContextMenu.Portal;
/** Groups related items. */
export const ContextMenuGroup = BaseContextMenu.Group;
/** Radio group for mutually exclusive items. */
export const ContextMenuRadioGroup = BaseContextMenu.RadioGroup;
/** Submenu root. */
export const ContextMenuSub = BaseContextMenu.SubmenuRoot;

/** Menu popup positioned at the pointer. */
export function ContextMenuContent({ className, ...props }: BaseContextMenu.Popup.Props) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-(--z-popover) max-h-(--available-height)">
        <BaseContextMenu.Popup data-slot="context-menu-content" className={cn(menuPopupClass, "max-h-(--available-height)", className)} {...props} />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

export interface ContextMenuItemProps extends BaseContextMenu.Item.Props {
  variant?: "default" | "destructive";
  inset?: boolean;
}

/** Actionable menu item. `variant="destructive"` colours it red. */
export function ContextMenuItem({ className, variant = "default", inset, ...props }: ContextMenuItemProps) {
  return (
    <BaseContextMenu.Item
      data-slot="context-menu-item"
      data-variant={variant}
      data-inset={inset || undefined}
      className={cn(menuItemClass, variant === "destructive" && menuItemDestructiveClass, className)}
      {...props}
    />
  );
}

/** Toggleable menu item with a check indicator. */
export function ContextMenuCheckboxItem({ className, children, ...props }: BaseContextMenu.CheckboxItem.Props) {
  return (
    <BaseContextMenu.CheckboxItem data-slot="context-menu-checkbox-item" className={cn(menuItemClass, "pl-8", className)} {...props}>
      <BaseContextMenu.CheckboxItemIndicator className="absolute left-2 flex size-4 items-center justify-center">
        <CheckIcon className="size-4" />
      </BaseContextMenu.CheckboxItemIndicator>
      {children}
    </BaseContextMenu.CheckboxItem>
  );
}

/** Radio menu item — use inside ContextMenuRadioGroup. */
export function ContextMenuRadioItem({ className, children, ...props }: BaseContextMenu.RadioItem.Props) {
  return (
    <BaseContextMenu.RadioItem data-slot="context-menu-radio-item" className={cn(menuItemClass, "pl-8", className)} {...props}>
      <BaseContextMenu.RadioItemIndicator className="absolute left-2 flex size-4 items-center justify-center">
        <CircleIcon className="size-2 fill-current" />
      </BaseContextMenu.RadioItemIndicator>
      {children}
    </BaseContextMenu.RadioItem>
  );
}

export interface ContextMenuLabelProps extends BaseContextMenu.GroupLabel.Props {
  inset?: boolean;
}

/** Non-interactive label for a group. */
export function ContextMenuLabel({ className, inset, ...props }: ContextMenuLabelProps) {
  return (
    <BaseContextMenu.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset || undefined}
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground data-[inset]:pl-8", className)}
      {...props}
    />
  );
}

/** Horizontal divider between items. */
export function ContextMenuSeparator({ className, ...props }: BaseContextMenu.Separator.Props) {
  return <BaseContextMenu.Separator data-slot="context-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

/** Right-aligned keyboard shortcut hint. */
export function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="context-menu-shortcut" className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)} {...props} />;
}

export interface ContextMenuSubTriggerProps extends BaseContextMenu.SubmenuTrigger.Props {
  inset?: boolean;
}

/** Item that opens a submenu; renders a trailing chevron. */
export function ContextMenuSubTrigger({ className, inset, children, ...props }: ContextMenuSubTriggerProps) {
  return (
    <BaseContextMenu.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset || undefined}
      className={cn(menuItemClass, "data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </BaseContextMenu.SubmenuTrigger>
  );
}

/** Submenu popup, positioned to the side of its trigger. */
export function ContextMenuSubContent({ className, ...props }: BaseContextMenu.Popup.Props) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner side="inline-end" align="start" sideOffset={2} alignOffset={-4} className="z-(--z-popover)">
        <BaseContextMenu.Popup data-slot="context-menu-sub-content" className={cn(menuPopupClass, className)} {...props} />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}
