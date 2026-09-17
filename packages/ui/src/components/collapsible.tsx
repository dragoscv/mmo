"use client";

import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { cn } from "../lib/cn";

/** Collapsible root; controls open state. */
export const Collapsible = BaseCollapsible.Root;

/** Button that toggles the panel. Style with `data-panel-open`. */
export function CollapsibleTrigger({ className, ...props }: BaseCollapsible.Trigger.Props) {
  return <BaseCollapsible.Trigger data-slot="collapsible-trigger" className={cn("group/collapsible outline-none focus-visible:ring-3 focus-visible:ring-ring/40 rounded-md", className)} {...props} />;
}

/** Content that animates height open/closed. */
export function CollapsiblePanel({ className, ...props }: BaseCollapsible.Panel.Props) {
  return (
    <BaseCollapsible.Panel
      data-slot="collapsible-panel"
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--dur-base) ease-(--ease-out) data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

/** shadcn alias for CollapsiblePanel. */
export const CollapsibleContent = CollapsiblePanel;
