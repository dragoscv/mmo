/**
 * Small building blocks shared by the tiered (zero-scroll) panels: element
 * size measurement, the motion gate, a ≥24 px icon button and the "more
 * controls" popover that smaller tiers use so no control is ever lost.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger, cn } from "@mmo/ui";

/** Client size (incl. padding, excl. border) of an element, kept current with a ResizeObserver. */
export function useElementSize<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [size, setSize] = useState({ w: 0, h: 0 });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const read = () =>
            setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
        read();
        if (typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return [ref, size] as const;
}

/** Layout animations allowed (OS setting, theme pref and the frame-budget governor). */
export { useMotionOK } from "@/shell/motion";

export type TierLayoutProps = {
    layout?: true;
    layoutId?: string;
    layoutDependency?: string;
    transition?: { duration: number; ease: "easeOut" };
};

/**
 * Motion props for blocks that morph between tiers. Tier changes remount the
 * block tree, so each block gets a stable `layoutId` (scope + block name) and
 * Motion cross-fades/morphs from the old box. Measurement only happens when
 * the tier changes (`layoutDependency`), so nothing animates continuously.
 */
export function tierLayout(ok: boolean, tier: string, scope: string): (block: string) => TierLayoutProps {
    if (!ok) return () => ({});
    return (block) => ({ layout: true, layoutId: `${scope}:${block}`, layoutDependency: tier, transition: { duration: 0.18, ease: "easeOut" } });
}

/** 24×24 icon button (look from `dk-btn` in src/look/look.css). */
export const iconBtn = "dk-btn dk-btn-icon";

/** Popover opened from a 24×24 icon button; holds controls a smaller tier hides. */
export function MorePopover({
    label,
    icon,
    title,
    children,
    className,
    contentClassName,
    side = "bottom",
    triggerClassName,
    triggerContent,
}: {
    /** Accessible name of the trigger. */
    label: string;
    icon?: ReactNode;
    /** Visible heading inside the popover (defaults to `label`). */
    title?: string;
    children: ReactNode;
    className?: string;
    contentClassName?: string;
    side?: "top" | "bottom" | "left" | "right";
    /** Replaces the default icon-button look (e.g. a text button). */
    triggerClassName?: string;
    triggerContent?: ReactNode;
}) {
    return (
        <Popover>
            <PopoverTrigger aria-label={label} title={label} className={cn(triggerClassName ?? iconBtn, className)}>
                {triggerContent ?? icon ?? <MoreHorizontal size={14} aria-hidden />}
            </PopoverTrigger>
            <PopoverContent side={side} className={cn("grid w-auto max-w-[min(92vw,24rem)] gap-2 p-3", contentClassName)}>
                <PopoverTitle className="dk-label">{title ?? label}</PopoverTitle>
                {children}
            </PopoverContent>
        </Popover>
    );
}

/** Tiny uppercase section label used inside panels. */
export function PanelLabel({ children, className }: { children: ReactNode; className?: string }) {
    return <span className={cn("dk-label truncate", className)}>{children}</span>;
}
