"use client";

import type * as React from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";
import { cn } from "../lib/cn";

/** Dropdown menu root. */
export const DropdownMenu = BaseMenu.Root;
/** Button that opens the menu. */
export const DropdownMenuTrigger = BaseMenu.Trigger;
/** Portal used by DropdownMenuContent. */
export const DropdownMenuPortal = BaseMenu.Portal;
/** Groups related items. */
export const DropdownMenuGroup = BaseMenu.Group;
/** Radio group for mutually exclusive items. */
export const DropdownMenuRadioGroup = BaseMenu.RadioGroup;
/** Submenu root. */
export const DropdownMenuSub = BaseMenu.SubmenuRoot;

export const menuPopupClass =
  "surface z-(--z-popover) min-w-[8rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 text-popover-foreground outline-none transition-[opacity,scale] duration-(--dur-fast) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

export const menuItemClass =
  "relative flex h-control-sm cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors duration-(--dur-fast) data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[inset]:pl-8";

export const menuItemDestructiveClass =
  "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive [&_svg]:text-destructive";

export interface DropdownMenuContentProps extends BaseMenu.Popup.Props {
  side?: BaseMenu.Positioner.Props["side"];
  align?: BaseMenu.Positioner.Props["align"];
  sideOffset?: number;
  alignOffset?: number;
}

/** Positioned, animated menu popup. */
export function DropdownMenuContent({ className, side = "bottom", align = "start", sideOffset = 4, alignOffset, ...props }: DropdownMenuContentProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side={side} align={align} sideOffset={sideOffset} alignOffset={alignOffset} className="z-(--z-popover) max-h-(--available-height)">
        <BaseMenu.Popup data-slot="dropdown-menu-content" className={cn(menuPopupClass, "max-h-(--available-height)", className)} {...props} />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export interface DropdownMenuItemProps extends BaseMenu.Item.Props {
  variant?: "default" | "destructive";
  inset?: boolean;
}

/** Actionable menu item. `variant="destructive"` colours it red. */
export function DropdownMenuItem({ className, variant = "default", inset, ...props }: DropdownMenuItemProps) {
  return (
    <BaseMenu.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      data-inset={inset || undefined}
      className={cn(menuItemClass, variant === "destructive" && menuItemDestructiveClass, className)}
      {...props}
    />
  );
}

/** Toggleable menu item with a check indicator. */
export function DropdownMenuCheckboxItem({ className, children, ...props }: BaseMenu.CheckboxItem.Props) {
  return (
    <BaseMenu.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn(menuItemClass, "pl-8", className)} {...props}>
      <BaseMenu.CheckboxItemIndicator className="absolute left-2 flex size-4 items-center justify-center">
        <CheckIcon className="size-4" />
      </BaseMenu.CheckboxItemIndicator>
      {children}
    </BaseMenu.CheckboxItem>
  );
}

/** Radio menu item — use inside DropdownMenuRadioGroup. */
export function DropdownMenuRadioItem({ className, children, ...props }: BaseMenu.RadioItem.Props) {
  return (
    <BaseMenu.RadioItem data-slot="dropdown-menu-radio-item" className={cn(menuItemClass, "pl-8", className)} {...props}>
      <BaseMenu.RadioItemIndicator className="absolute left-2 flex size-4 items-center justify-center">
        <CircleIcon className="size-2 fill-current" />
      </BaseMenu.RadioItemIndicator>
      {children}
    </BaseMenu.RadioItem>
  );
}

export interface DropdownMenuLabelProps extends BaseMenu.GroupLabel.Props {
  inset?: boolean;
}

/** Non-interactive label for a group. */
export function DropdownMenuLabel({ className, inset, ...props }: DropdownMenuLabelProps) {
  return (
    <BaseMenu.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset || undefined}
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground data-[inset]:pl-8", className)}
      {...props}
    />
  );
}

/** Horizontal divider between items. */
export function DropdownMenuSeparator({ className, ...props }: BaseMenu.Separator.Props) {
  return <BaseMenu.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

/** Right-aligned keyboard shortcut hint. */
export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="dropdown-menu-shortcut" className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)} {...props} />;
}

export interface DropdownMenuSubTriggerProps extends BaseMenu.SubmenuTrigger.Props {
  inset?: boolean;
}

/** Item that opens a submenu; renders a trailing chevron. */
export function DropdownMenuSubTrigger({ className, inset, children, ...props }: DropdownMenuSubTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset || undefined}
      className={cn(menuItemClass, "data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </BaseMenu.SubmenuTrigger>
  );
}

/** Submenu popup, positioned to the side of its trigger. */
export function DropdownMenuSubContent({ className, ...props }: BaseMenu.Popup.Props) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side="inline-end" align="start" sideOffset={2} alignOffset={-4} className="z-(--z-popover)">
        <BaseMenu.Popup data-slot="dropdown-menu-sub-content" className={cn(menuPopupClass, className)} {...props} />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}
