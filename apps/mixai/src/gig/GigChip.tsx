/**
 * Status-bar item of the gig lock (rendered by shell/StatusBar.tsx, before the practice chip):
 * a padlock + "GIG", and the word "Locked" while the lock is on. Clicking opens the popover
 * (lock / unlock, what the lock covers, the checklist, what was held back).
 *
 * It is a popover trigger, not a toggle: whether the lock is on is in its accessible name and
 * in `data-on`. The status-bar fit may hide the chip (`data-prio`) only while the lock is off
 * and the popover is closed: a locked app can always be unlocked from here (and with
 * Ctrl/Cmd+Shift+G, and from the command palette), and a popover opened from the command
 * palette on a narrow bar has its anchor.
 *
 * The chip also speaks for the lock: a refusal ("Settings are locked for the set..."), a
 * change of the lock, or a start that comes back locked is said through the shell's status
 * region (`useAnnounce`: a polite live region plus one line above the status bar, on screen for
 * `SAY_MS`). The same refusal said again is announced again (the region re-inserts its text).
 * Plugin toasts are hidden while locked, so this never goes through them.
 *
 * Subscribes to four small values of the gig store; nothing here renders while they are still.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import { platform } from "@/bridge/window";
import { translate, useLocale, useT } from "@/i18n";
import { consumeBareArrows } from "@/remote/remote-core";
import { useAnnounce } from "@/shell/shell-hotkeys";
import { hotkeyText } from "./gig-core";
import { useGigStore } from "./gig-store";

const GigPopover = lazy(() => import("./GigPopover").then((m) => ({ default: m.GigPopover })));

/** Hidden by the status-bar fit before the practice chip (45) when the bar is narrow; only while the lock is off. */
const PRIO = 46;

/** How long a sentence of the lock stays on screen (the shell's default is 2.2 s: too short to read a refusal). */
export const SAY_MS = 5000;

/** Local time of day "21:05" for the lock time; "?" when it is not known. */
export function clockOf(since: number, locale: string): string {
    if (!(since > 0)) return "?";
    return new Date(since).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** Says the gig store's notices in the shell status region, in the current language. */
function useGigVoice(): void {
    const locale = useLocale();
    const notice = useGigStore((s) => s.notice);
    const said = useRef(0);
    useEffect(() => {
        if (!notice || notice.seq === said.current) return;
        said.current = notice.seq;
        const vars = { key: hotkeyText(platform()), since: clockOf(useGigStore.getState().since, locale) };
        useAnnounce.getState().say(translate(locale, `gig.say.${notice.id}`, vars), SAY_MS);
    }, [notice, locale]);
}

export function GigChip() {
    const t = useT();
    const locale = useLocale();
    const locked = useGigStore((s) => s.locked);
    const since = useGigStore((s) => s.since);
    const toasts = useGigStore((s) => s.skipped.toasts);
    const open = useGigStore((s) => s.open);
    const setOpen = useGigStore((s) => s.setOpen);
    const ref = useRef<HTMLButtonElement>(null);
    useGigVoice();
    // The fit only un-hides items it still manages: a chip that stops being one (locked, or its
    // popover open) shows itself; the size change makes the fit run again and hide something
    // less important.
    const pinned = locked || open;
    useLayoutEffect(() => {
        if (pinned && ref.current?.hidden) ref.current.hidden = false;
    }, [pinned]);
    const at = clockOf(since, locale);
    const label = !locked ? t("gig.chipAriaOff") : toasts > 0 ? t("gig.chipAriaOnToasts", { since: at, n: toasts }) : t("gig.chipAriaOn", { since: at });
    return (
        <Popover open={open} onOpenChange={(next) => setOpen(next)}>
            <PopoverTrigger ref={ref} className="sb-item gg-chip" data-prio={pinned ? undefined : PRIO} data-on={locked} data-gig-chip="" aria-label={label} title={locked ? t("gig.lockedSince", { since: at }) : t("gig.chipTip")}>
                {locked ? <Lock className="gg-chip-icon" size={10} aria-hidden /> : <LockOpen className="gg-chip-icon" size={10} aria-hidden />}
                <span className="dk-label">{t("gig.chip")}</span>
                {locked && <strong className="sb-word gg-chip-word">{t("gig.chipLocked")}</strong>}
            </PopoverTrigger>
            {/* Bare arrows are the app's crossfader shortcuts: none may leave the popover unused. */}
            <PopoverContent
                side="top"
                align="end"
                className="gg-pop"
                onKeyDown={(e) => {
                    consumeBareArrows(e);
                }}
            >
                <PopoverTitle className="dk-label">{t("gig.title")}</PopoverTitle>
                {open && (
                    <Suspense fallback={null}>
                        <GigPopover />
                    </Suspense>
                )}
            </PopoverContent>
        </Popover>
    );
}
