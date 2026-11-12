/**
 * Status-bar item of practice mode (rendered by shell/StatusBar.tsx): "PRACTICE" + the live
 * score while it is on. Clicking opens the popover with the switch, the criteria and the tips.
 *
 * The chip subscribes to two values (on, score), both whole numbers that change at most a few
 * times a second while mixing, and to nothing while practice is off.
 *
 * It is a popover trigger, not a toggle: the library gives it `aria-haspopup` / `aria-expanded`;
 * whether practice runs is in its name ("…, on") and in `data-on` for the styling. The chip is
 * the only way into practice mode, so the status-bar fit may hide it (`data-prio`) only while
 * practice is off: a running session can always be reached and stopped.
 */
import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import { useT } from "@/i18n";
import { consumeBareArrows } from "@/remote/remote-core";
import { usePracticeStore } from "./practice-store";

const PracticePopover = lazy(() => import("./PracticePopover").then((m) => ({ default: m.PracticePopover })));

/** Hidden by the status-bar fit before the library link (40) when the bar is narrow; only while practice is off. */
const PRIO = 45;

export function PracticeChip() {
    const t = useT();
    const on = usePracticeStore((s) => s.on);
    const score = usePracticeStore((s) => s.score);
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLButtonElement>(null);
    // The fit only un-hides items it still manages: a chip that stops being one shows itself
    // (the size change makes the fit run again and hide something less important).
    useLayoutEffect(() => {
        if (on && ref.current?.hidden) ref.current.hidden = false;
    }, [on]);
    const state = on ? t("practice.on") : t("practice.off");
    const label = on && score !== null ? t("practice.chipAriaScore", { state, score }) : t("practice.chipAria", { state });
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger ref={ref} className="sb-item pr-chip" data-prio={on ? undefined : PRIO} data-on={on} aria-label={label} title={t("practice.chipTip")}>
                <i className="sb-dot" data-state={on ? "online" : "offline"} />
                <span className="dk-label">{t("practice.chip")}</span>
                {on && <span className="dk-num dk-num-sm pr-chip-score">{score === null ? t("practice.noScore") : score}</span>}
            </PopoverTrigger>
            {/* Bare arrows are the app's crossfader shortcuts: none may leave the popover unused. */}
            <PopoverContent
                side="top"
                align="end"
                className="pr-pop"
                onKeyDown={(e) => {
                    consumeBareArrows(e);
                }}
            >
                <PopoverTitle className="dk-label">{t("practice.title")}</PopoverTitle>
                {open && (
                    <Suspense fallback={null}>
                        <PracticePopover />
                    </Suspense>
                )}
            </PopoverContent>
        </Popover>
    );
}
