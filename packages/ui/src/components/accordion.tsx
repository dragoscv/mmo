"use client";

import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../lib/cn";

/** Accordion root; `multiple` allows several open items. */
export function Accordion({ className, ...props }: BaseAccordion.Root.Props) {
  return <BaseAccordion.Root data-slot="accordion" className={cn("flex w-full flex-col", className)} {...props} />;
}

/** One expandable section. */
export function AccordionItem({ className, ...props }: BaseAccordion.Item.Props) {
  return <BaseAccordion.Item data-slot="accordion-item" className={cn("border-b border-border last:border-b-0", className)} {...props} />;
}

/** Heading button that toggles the panel; chevron rotates when open. */
export function AccordionTrigger({ className, children, ...props }: BaseAccordion.Trigger.Props) {
  return (
    <BaseAccordion.Header className="flex">
      <BaseAccordion.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion flex flex-1 cursor-pointer items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium outline-none transition-colors duration-(--dur-fast) hover:underline focus-visible:ring-3 focus-visible:ring-ring/40 data-disabled:pointer-events-none data-disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="size-4 shrink-0 translate-y-0.5 text-muted-foreground transition-transform duration-(--dur-base) ease-(--ease-out) group-data-[panel-open]/accordion:rotate-180" />
      </BaseAccordion.Trigger>
    </BaseAccordion.Header>
  );
}

/** Content that animates height open/closed. */
export function AccordionPanel({ className, children, ...props }: BaseAccordion.Panel.Props) {
  return (
    <BaseAccordion.Panel
      data-slot="accordion-panel"
      className={cn(
        "h-(--accordion-panel-height) overflow-hidden text-sm transition-[height,opacity] duration-(--dur-base) ease-(--ease-out) data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0",
        className,
      )}
      {...props}
    >
      <div className="pb-4">{children}</div>
    </BaseAccordion.Panel>
  );
}

/** shadcn alias for AccordionPanel. */
export const AccordionContent = AccordionPanel;
