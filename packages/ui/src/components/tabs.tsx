"use client";

import * as React from "react";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cn } from "../lib/cn.ts";

/** Tabs root; controls the active tab value. */
export function Tabs({ className, ...props }: BaseTabs.Root.Props) {
  return <BaseTabs.Root data-slot="tabs" className={cn("flex flex-col gap-2 data-[orientation=vertical]:flex-row", className)} {...props} />;
}

export type TabsListVariant = "default" | "line";

const TabsVariantContext = React.createContext<TabsListVariant>("default");

export interface TabsListProps extends BaseTabs.List.Props {
  /** `default` = pill segment on `bg-muted`; `line` = underline indicator. */
  variant?: TabsListVariant;
}

/** Container for tab triggers with an animated active indicator. */
export function TabsList({ className, variant = "default", children, ...props }: TabsListProps) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <BaseTabs.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(
          "relative isolate inline-flex w-fit items-center text-muted-foreground data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
          variant === "default" ? "h-control-sm gap-0.5 rounded-lg bg-muted p-0.5" : "h-control gap-1 border-b border-border data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-r",
          className,
        )}
        {...props}
      >
        {children}
        <BaseTabs.Indicator
          data-slot="tabs-indicator"
          className={cn(
            "absolute -z-10 transition-[left,top,width,height] duration-(--dur-base) ease-(--ease-out)",
            variant === "default"
              ? "top-(--active-tab-top) left-(--active-tab-left) h-(--active-tab-height) w-(--active-tab-width) rounded-md bg-background shadow-xs"
              : "bottom-0 left-(--active-tab-left) h-0.5 w-(--active-tab-width) rounded-full bg-primary data-[orientation=vertical]:top-(--active-tab-top) data-[orientation=vertical]:right-0 data-[orientation=vertical]:bottom-auto data-[orientation=vertical]:left-auto data-[orientation=vertical]:h-(--active-tab-height) data-[orientation=vertical]:w-0.5",
          )}
        />
      </BaseTabs.List>
    </TabsVariantContext.Provider>
  );
}

/** Individual tab button. Keyboard arrows / D-pad move focus and activation. */
export function TabsTrigger({ className, ...props }: BaseTabs.Tab.Props) {
  const variant = React.useContext(TabsVariantContext);
  return (
    <BaseTabs.Tab
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-full flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap px-3 text-sm font-medium outline-none transition-colors duration-(--dur-fast) select-none",
        "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === "default" ? "rounded-md" : "rounded-t-md",
        className,
      )}
      {...props}
    />
  );
}

/** Panel shown for the matching tab value. */
export function TabsContent({ className, ...props }: BaseTabs.Panel.Props) {
  return <BaseTabs.Panel data-slot="tabs-content" className={cn("flex-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/40 rounded-md", className)} {...props} />;
}
