/**
 * Library-toolbar entry of the co-pilot (rendered by components/Library.tsx in the full and
 * compact tiers): sparkles + "COPILOT" (icon only in the compact tier), lit while its popover is
 * open. The icon changes while a transition runs and when the set-safety check asks for action,
 * and the accessible name says so. Open / closed is the popover trigger's own `aria-expanded`
 * (no `aria-pressed` on top of it); the lit look comes from `data-on`.
 *
 * A warning that asks for action now (severity 2) is announced assertively from here, because
 * this button is mounted while the popover is closed: once when it appears, not every time a
 * number in it changes.
 *
 * Arrow keys pressed anywhere in the open popover never reach the app's global shortcuts (bare
 * arrows = crossfader hard to A / B, centre): the popup stops them.
 *
 * The button subscribes to a few booleans / small numbers that change with transport, never
 * per frame. It probes the shell once and, only while a deck plays, asks for the safety check
 * every two seconds; an idle app makes no call.
 */
import { lazy, Suspense, useEffect, useState, type KeyboardEvent } from "react";
import { Blend, Sparkles, TriangleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import { useLocale, useT } from "@/i18n";
import { usePanelTier } from "@/layout/panel-tier";
import { useMixerStore } from "@/state/mixer-store";
import { useCopilotStore } from "./copilot-store";
import { keepArrowFromShortcuts } from "./features.ts";
import { urgentKey, warningText } from "./texts.ts";
import { useCount } from "./use-count.ts";

const CopilotPopover = lazy(() => import("./CopilotPopover").then((m) => ({ default: m.CopilotPopover })));

const SAFETY_MS = 2000;

/** An arrow key on a control that did not use it: handled here, so it is not a global shortcut. */
function keepArrows(e: KeyboardEvent<HTMLElement>): void {
    if (keepArrowFromShortcuts(e, e.target as HTMLElement)) e.preventDefault();
}

export function CopilotButton() {
    const t = useT();
    const locale = useLocale();
    const count = useCount();
    const compact = usePanelTier() !== "full";
    const open = useCopilotStore((s) => s.open);
    const setOpen = useCopilotStore((s) => s.setOpen);
    const available = useCopilotStore((s) => s.available);
    const running = useCopilotStore((s) => s.run !== null);
    const warnings = useCopilotStore((s) => s.warnings.length);
    // Codes of the warnings that ask for action now ("" = none): changes when one appears or goes.
    const urgentCodes = useCopilotStore((s) => urgentKey(s.warnings));
    const urgent = urgentCodes.length > 0;
    const anyPlaying = useMixerStore((s) => s.decks.some((d) => d.loaded && d.playing));

    // What the assertive live region says: written when the SET of urgent warnings changes.
    const [urgentText, setUrgentText] = useState("");
    useEffect(() => {
        if (!urgentCodes) {
            setUrgentText("");
            return;
        }
        const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
        const lines = useCopilotStore
            .getState()
            .warnings.filter((w) => w.severity >= 2)
            .map((w) => `${t("copilot.sev.2")}: ${warningText(t, w, count, (n) => fmt.format(n))}`);
        setUrgentText(lines.join(". "));
    }, [urgentCodes, t, count, locale]);

    // Does the running shell know the co-pilot? (One call; also picks up a transition in flight.)
    useEffect(() => {
        if (available === "unknown") void useCopilotStore.getState().probe();
    }, [available]);

    // Set safety: every two seconds while a deck plays; one last call clears it when playback stops.
    useEffect(() => {
        const check = () => void useCopilotStore.getState().refreshSafety();
        check();
        if (available !== "yes" || !anyPlaying) return;
        const id = window.setInterval(check, SAFETY_MS);
        return () => window.clearInterval(id);
    }, [available, anyPlaying]);

    // Leaving the toolbar (icon tier, another source) closes the popover state with it.
    useEffect(() => () => useCopilotStore.getState().setOpen(false), []);

    const label = [t("copilot.buttonAria"), running ? t("copilot.buttonRunning") : null, warnings > 0 ? t("copilot.buttonWarnings", { warnings: count("warnings", warnings) }) : null].filter(Boolean).join(", ");
    const Icon = running ? Blend : urgent ? TriangleAlert : Sparkles;
    return (
        <>
            <Popover open={open} onOpenChange={(o) => setOpen(o)}>
                <PopoverTrigger
                    className="dk-btn dk-btn-xs cp-btn"
                    data-cp-trigger=""
                    data-on={open}
                    data-running={running || undefined}
                    data-urgent={urgent || undefined}
                    aria-label={label}
                    title={label}
                >
                    <Icon size={12} aria-hidden />
                    {!compact && <span>{t("copilot.button")}</span>}
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="cp-pop" onKeyDown={keepArrows}>
                    <PopoverTitle className="dk-label">{t("copilot.title")}</PopoverTitle>
                    {open && (
                        <Suspense fallback={null}>
                            <CopilotPopover />
                        </Suspense>
                    )}
                </PopoverContent>
            </Popover>
            {/* Always mounted and empty until there is something to say: an assertive region must exist before its text. */}
            <span className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-cp-alert="">
                {urgentText}
            </span>
        </>
    );
}
