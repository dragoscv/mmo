"use client";

import * as React from "react";
import { motion, LayoutGroup } from "motion/react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";
import { MoreHorizontalIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";
import { useHaptics } from "../hooks/index";

export interface BottomTabItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  href?: string;
  onSelect?: () => void;
  active?: boolean;
  badge?: React.ReactNode;
  /** Base UI render prop, e.g. `<Link href="/x" />` for Next.js. */
  render?: useRender.ComponentProps<"a">["render"];
}

export interface BottomTabBarProps extends Omit<React.ComponentProps<"nav">, "children"> {
  items: BottomTabItem[];
  moreLabel?: string;
  /** Max visible slots including the "More" slot. Default 5. */
  maxSlots?: number;
  /** Unique id for the motion layout group — set when several bars exist. */
  layoutId?: string;
}

export const BOTTOM_TAB_BAR_HEIGHT = "3.5rem";

function TabButton({ item, onSelected, layoutId, className }: { item: BottomTabItem; onSelected?: () => void; layoutId: string; className?: string }) {
  const haptic = useHaptics();
  const isLink = Boolean(item.href) || Boolean(item.render);
  const own: React.ComponentPropsWithoutRef<"a"> & Record<`data-${string}`, unknown> = {
    "data-slot": "bottom-tab",
    "data-active": item.active || undefined,
    "aria-current": item.active ? "page" : undefined,
    href: item.href,
    className: cn(
      "relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.6875rem] font-medium text-muted-foreground outline-none select-none",
      "transition-colors duration-(--dur-fast) ease-(--ease-out) focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-95",
      "data-[active]:text-primary [&_svg]:size-5 [&_svg]:shrink-0",
      className,
    ),
    onClick: () => {
      haptic("tap");
      item.onSelect?.();
      onSelected?.();
    },
    children: (
      <>
        {item.active ? (
          <motion.span
            layoutId={`${layoutId}-indicator`}
            aria-hidden
            className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary"
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
          />
        ) : null}
        <span className="relative">
          {item.icon}
          {item.badge ? <span className="absolute -top-1 -right-2 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 text-primary-foreground">{item.badge}</span> : null}
        </span>
        <span className="max-w-full truncate">{item.label}</span>
      </>
    ),
  };
  return useRender({
    render: item.render ?? (isLink ? <a /> : <button type="button" />),
    props: mergeProps<"a">(own, {}),
  });
}

export function BottomTabBar({ items, moreLabel, maxSlots = 5, layoutId = "bottom-tab-bar", className, ...props }: BottomTabBarProps) {
  const t = useUiT();
  const haptic = useHaptics();
  const [moreOpen, setMoreOpen] = React.useState(false);

  const needsMore = items.length > maxSlots;
  const visible = needsMore ? items.slice(0, maxSlots - 1) : items;
  const overflow = needsMore ? items.slice(maxSlots - 1) : [];
  const overflowActive = overflow.some((i) => i.active);

  return (
    <LayoutGroup id={layoutId}>
      <nav
        data-slot="bottom-tab-bar"
        aria-label={t("common.more")}
        className={cn(
          "fixed inset-x-0 bottom-0 z-(--z-sidebar) flex items-stretch border-t border-border bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75 md:hidden",
          "pb-[var(--safe-bottom)] pl-[var(--safe-left)] pr-[var(--safe-right)]",
          className,
        )}
        style={{ height: `calc(${BOTTOM_TAB_BAR_HEIGHT} + var(--safe-bottom, 0px))` }}
        {...props}
      >
        {visible.map((item) => (
          <TabButton key={item.id} item={item} layoutId={layoutId} />
        ))}
        {needsMore ? (
          <button
            type="button"
            data-slot="bottom-tab"
            data-active={overflowActive || undefined}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={cn(
              "relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.6875rem] font-medium text-muted-foreground outline-none select-none",
              "transition-colors duration-(--dur-fast) focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-95 data-[active]:text-primary [&_svg]:size-5",
            )}
            onClick={() => {
              haptic("tap");
              setMoreOpen(true);
            }}
          >
            {overflowActive ? <motion.span layoutId={`${layoutId}-indicator`} aria-hidden className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary" /> : null}
            <MoreHorizontalIcon aria-hidden />
            <span className="truncate">{moreLabel ?? t("common.more")}</span>
          </button>
        ) : null}
      </nav>

      {needsMore ? (
        <BaseDialog.Root open={moreOpen} onOpenChange={setMoreOpen} modal>
          <BaseDialog.Portal>
            <BaseDialog.Backdrop className="fixed inset-0 z-(--z-overlay) bg-black/50 backdrop-blur-[2px] transition-opacity duration-(--dur-base) data-ending-style:opacity-0 data-starting-style:opacity-0 md:hidden" />
            <BaseDialog.Popup
              data-slot="bottom-tab-more"
              aria-label={moreLabel ?? t("common.more")}
              className={cn(
                "surface fixed inset-x-0 bottom-0 z-(--z-modal) flex max-h-[80dvh] flex-col gap-1 rounded-t-2xl p-3 pb-[max(1rem,var(--safe-bottom))] outline-none md:hidden",
                "transition-transform duration-(--dur-base) ease-(--ease-out) data-starting-style:translate-y-full data-ending-style:translate-y-full",
              )}
            >
              <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/40" />
              <ul className="grid grid-cols-4 gap-2 overflow-y-auto">
                {overflow.map((item) => (
                  <li key={item.id} className="contents">
                    <TabButton
                      item={item}
                      layoutId={`${layoutId}-more`}
                      onSelected={() => setMoreOpen(false)}
                      className="h-16 rounded-xl bg-muted/40 text-xs data-[active]:bg-accent data-[active]:text-accent-foreground"
                    />
                  </li>
                ))}
              </ul>
            </BaseDialog.Popup>
          </BaseDialog.Portal>
        </BaseDialog.Root>
      ) : null}
    </LayoutGroup>
  );
}
