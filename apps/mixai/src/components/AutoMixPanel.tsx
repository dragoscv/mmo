import { motion } from "motion/react";
import { Check, Circle, Play, SlidersHorizontal, Sparkles } from "lucide-react";
import { cn } from "@mmo/ui";
import { useAutoMixStore } from "@/state/auto-mix-store";
import { usePanelTier } from "@/layout/panel-tier";
import { useT } from "@/i18n";
import { MorePopover, tierLayout, useMotionOK } from "./panel-ui";

const btn =
    "inline-flex min-h-6 min-w-6 items-center justify-center gap-1 rounded-md border border-[var(--border)] px-2 text-[10px] font-bold tracking-[0.04em] focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50";

/** Status dot + text. The dot is decorative; the text carries the state. */
function Status({ className }: { className?: string }) {
    const enabled = useAutoMixStore((s) => s.enabled);
    const status = useAutoMixStore((s) => s.status);
    const mixing = useAutoMixStore((s) => s.mixing);
    const onAir = useAutoMixStore((s) => s.onAir);
    return (
        <div role="status" className={cn("flex min-h-4 min-w-0 items-center gap-1.5 text-[11px]", className)} style={{ color: enabled ? "var(--accent-2)" : "var(--fg-dim)" }}>
            {enabled && (
                <span
                    aria-hidden
                    className="size-[7px] shrink-0 rounded-full"
                    style={{ background: mixing ? "var(--warn)" : onAir === "a" ? "var(--accent-deck-a)" : "var(--accent-deck-b)", boxShadow: "var(--glow) currentColor" }}
                />
            )}
            <span className="truncate" title={status}>
                {status}
            </span>
        </div>
    );
}

function OnOff({ className }: { className?: string }) {
    const t = useT();
    const enabled = useAutoMixStore((s) => s.enabled);
    const setEnabled = useAutoMixStore((s) => s.setEnabled);
    return (
        <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            aria-pressed={enabled}
            aria-label={t("deckui.autoMixToggle")}
            className={cn(btn, "px-3.5 text-[11px] font-extrabold tracking-[0.06em]", className)}
            style={{ background: enabled ? "var(--accent)" : "var(--bg-elev-2)", color: enabled ? "var(--accent-fg)" : "var(--fg-dim)" }}
        >
            {enabled ? t("deckui.on") : t("deckui.off")}
        </button>
    );
}

function MixNow({ className }: { className?: string }) {
    const t = useT();
    const enabled = useAutoMixStore((s) => s.enabled);
    const mixing = useAutoMixStore((s) => s.mixing);
    const mixNow = useAutoMixStore((s) => s.mixNow);
    const off = !enabled || mixing;
    return (
        <button type="button" onClick={mixNow} disabled={off} title={t("deckui.mixNowHint")} className={cn(btn, "bg-[var(--bg-elev-2)]", className)} style={{ color: off ? "var(--fg-dim)" : "var(--fg)" }}>
            {t("deckui.mixNow")} <Play size={10} aria-hidden />
        </button>
    );
}

function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
    return (
        <label className="grid min-w-0 gap-0.5">
            <span className="flex justify-between text-[10px] text-[var(--fg-dim)]">
                <span className="truncate">{label}</span>
                <span className="mono text-[var(--fg)]">
                    {value}
                    {unit}
                </span>
            </span>
            <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-h-6 w-full min-w-0" />
        </label>
    );
}

/** Sliders + toggles, shared by the full tier and the popovers of the smaller ones. */
function Settings({ withMixNow }: { withMixNow: boolean }) {
    const t = useT();
    const crossfadeSec = useAutoMixStore((s) => s.crossfadeSec);
    const leadSec = useAutoMixStore((s) => s.leadSec);
    const autoSync = useAutoMixStore((s) => s.autoSync);
    const autoQueue = useAutoMixStore((s) => s.autoQueue);
    const setCrossfadeSec = useAutoMixStore((s) => s.setCrossfadeSec);
    const setLeadSec = useAutoMixStore((s) => s.setLeadSec);
    const setAutoSync = useAutoMixStore((s) => s.setAutoSync);
    const setAutoQueue = useAutoMixStore((s) => s.setAutoQueue);
    // State = aria-pressed + check/circle icon + fill (never colour only); the label stays short enough not to truncate.
    const toggle = (on: boolean, label: string, hint: string, set: (v: boolean) => void) => (
        <button
            type="button"
            onClick={() => set(!on)}
            aria-pressed={on}
            title={hint}
            className={cn(btn, "min-w-0 flex-1")}
            style={{ background: on ? "var(--accent)" : "var(--bg-elev-2)", color: on ? "var(--accent-fg)" : "var(--fg-dim)" }}
        >
            {on ? <Check size={11} aria-hidden className="shrink-0" /> : <Circle size={11} aria-hidden className="shrink-0" />}
            <span className="truncate">{label}</span>
        </button>
    );
    return (
        <>
            <Slider label={t("deckui.crossfade")} value={crossfadeSec} min={2} max={30} unit="s" onChange={setCrossfadeSec} />
            <Slider label={t("deckui.leadIn")} value={leadSec} min={4} max={40} unit="s" onChange={setLeadSec} />
            <div className="flex min-w-0 gap-1.5">
                {toggle(autoSync, t("deckui.beatSync"), t("deckui.beatSyncHint"), setAutoSync)}
                {toggle(autoQueue, t("deckui.autoQueue"), t("deckui.autoQueueHint"), setAutoQueue)}
            </div>
            {withMixNow && <MixNow className="w-full" />}
        </>
    );
}

/**
 * Auto-mix control surface — the "AI DJ". Arms a frontend orchestrator that
 * beat-syncs the idle deck and crossfades into it a few seconds before the
 * on-air track ends. All knobs are live; "Mix now" forces the next blend.
 *  - full: header + status + crossfade / lead-in + beat-sync / auto-queue / mix now
 *  - compact: header + status + mix now; the rest in a popover
 *  - icon: on/off toggle with a status dot; everything else in a popover
 */
export function AutoMixPanel() {
    const t = useT();
    const tier = usePanelTier();
    const lay = tierLayout(useMotionOK(), tier, "automix");
    const enabled = useAutoMixStore((s) => s.enabled);
    const mixing = useAutoMixStore((s) => s.mixing);

    const title = (
        <span className="mr-auto inline-flex min-w-0 items-center gap-1 truncate text-[10px] tracking-[0.12em] text-[var(--fg-dim)]">
            <Sparkles size={10} aria-hidden className="shrink-0" /> {t("deckui.autoMix")}
        </span>
    );
    const more = (
        <MorePopover label={t("deckui.autoMixMore")} title={t("deckui.autoMix")} icon={<SlidersHorizontal size={13} aria-hidden />} contentClassName="w-72">
            <Status />
            <Settings withMixNow />
        </MorePopover>
    );

    return (
        <section aria-label={t("deckui.autoMix")} data-tier={tier} className={cn("panel h-full w-full min-h-0 min-w-0 overflow-hidden", tier === "icon" ? "p-1.5" : "p-3")}>
            {tier === "full" && (
                <motion.div {...lay("body")} className="grid h-full min-h-0 content-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                        {title}
                        <OnOff />
                    </div>
                    <Status />
                    <Settings withMixNow />
                </motion.div>
            )}
            {tier === "compact" && (
                <motion.div {...lay("body")} className="grid h-full min-h-0 content-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                        {title}
                        <OnOff />
                    </div>
                    <Status />
                    <div className="flex min-w-0 items-center gap-1.5">
                        <MixNow className="flex-1" />
                        {more}
                    </div>
                </motion.div>
            )}
            {tier === "icon" && (
                <motion.div {...lay("body")} className="flex h-full min-h-0 min-w-0 items-center gap-1">
                    <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: !enabled ? "var(--bg-elev-2)" : mixing ? "var(--warn)" : "var(--good)", border: "1px solid var(--border)" }}
                    />
                    <OnOff className="h-full min-w-0 flex-1 px-1" />
                    {more}
                </motion.div>
            )}
        </section>
    );
}
