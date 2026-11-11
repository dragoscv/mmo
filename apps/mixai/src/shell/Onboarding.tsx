/**
 * First-run tour: where you come from (look-alike skin), a layout, a look, a controller.
 * Shown once (shell prefs `onboarded`); re-openable from Settings → About. Every step is
 * live (choices apply immediately) and skippable. Styles: shell.css `.ob-*`.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { Check } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mmo/ui";
import { useLayoutStore } from "@/layout/layout-store";
import { BUILTIN_LAYOUTS, layoutName } from "@/layout/presets";
import { BUILTIN_SKINS } from "@/packs/builtin-skins";
import { skinDescription, skinName } from "@/packs/skin-text";
import { usePackStore } from "@/packs/pack-store";
import { useUiStore } from "@/state/ui-store";
import { useShellPrefs } from "./shell-prefs";
import { useMotionOK } from "./motion";
import { useT, type MessageKey } from "@/i18n";

const STEPS = ["from", "layout", "skin", "controller"] as const;

/** Look-alike skins per app the DJ may come from (text only: no logos, see `fromLegal`). */
const FROM: { key: string; label: MessageKey; skin: string | null }[] = [
    { key: "rekordbox", label: "shell.tour.fromRekordbox", skin: "ro.mixai.skin.mainroom" },
    { key: "serato", label: "shell.tour.fromSerato", skin: "ro.mixai.skin.crate" },
    { key: "virtualdj", label: "shell.tour.fromVirtualdj", skin: "ro.mixai.skin.pilot" },
    { key: "mixai", label: "shell.tour.fromNew", skin: null },
];

interface Choice {
    key: string;
    title: string;
    detail?: string;
    /** Shown but not selectable (with `detail` saying why). */
    unavailable?: boolean;
}

/** Radio group of flat tiles: arrow keys move and select, one tab stop, check mark on the chosen one. */
function Choices({ label, columns, items, value, onPick }: { label: string; columns: number; items: Choice[]; value: string | null; onPick: (key: string) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const usable = items.filter((i) => !i.unavailable);
    const tabStop = usable.find((i) => i.key === value)?.key ?? usable[0]?.key;
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step || usable.length === 0) return;
        e.preventDefault();
        const at = usable.findIndex((i) => i.key === (e.target as HTMLElement).dataset.key);
        const next = usable[(Math.max(0, at) + step + usable.length) % usable.length]!;
        onPick(next.key);
        ref.current?.querySelector<HTMLElement>(`[data-key="${next.key}"]`)?.focus();
    };
    return (
        <div ref={ref} role="radiogroup" aria-label={label} className="ob-choices" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} onKeyDown={onKey}>
            {items.map((i) => {
                const checked = !i.unavailable && value === i.key;
                return (
                    <button
                        key={i.key}
                        type="button"
                        role="radio"
                        data-key={i.key}
                        aria-checked={checked}
                        aria-disabled={i.unavailable || undefined}
                        tabIndex={i.key === tabStop ? 0 : -1}
                        className="ob-choice"
                        onClick={() => !i.unavailable && onPick(i.key)}
                    >
                        <span className="ob-choice-title">{i.title}</span>
                        {i.detail && <span className="ob-choice-detail">{i.detail}</span>}
                        <Check aria-hidden className="ob-choice-check" />
                    </button>
                );
            })}
        </div>
    );
}

function Step({ title, detail, children, note }: { title: string; detail: string; children: ReactNode; note?: string }) {
    return (
        <>
            <h3 className="ob-title">{title}</h3>
            <p className="ob-detail">{detail}</p>
            {children}
            {note && <p className="ob-note">{note}</p>}
        </>
    );
}

export function Onboarding() {
    const t = useT();
    const onboarded = useShellPrefs((s) => s.onboarded);
    const setPrefs = useShellPrefs((s) => s.set);
    const activeLayout = useLayoutStore((s) => s.activeId);
    const setLayout = useLayoutStore((s) => s.setActive);
    const activeSkin = usePackStore((s) => s.activeSkin);
    const setSkin = usePackStore((s) => s.setActiveSkin);
    const [step, setStep] = useState(0);
    const motionOK = useMotionOK();
    const finish = () => setPrefs({ onboarded: true });
    const key = STEPS[step]!;

    const hasSkin = (id: string | null) => id === null || BUILTIN_SKINS.some((s) => s.manifest.id === id);
    const fromItems: Choice[] = FROM.map((f) => {
        const name = t(f.label);
        if (f.skin === null) return { key: f.key, title: name, detail: t("shell.tour.fromNewDetail") };
        return hasSkin(f.skin) ? { key: f.key, title: name, detail: t("shell.tour.fromApplies", { name }) } : { key: f.key, title: name, detail: t("shell.tour.fromSoon"), unavailable: true };
    });
    const fromValue = FROM.find((f) => f.skin === activeSkin)?.key ?? null;
    const skinItems: Choice[] = [
        { key: "", title: t("shell.tour.skinDefault"), detail: t("shell.tour.skinDefaultDetail") },
        ...BUILTIN_SKINS.map((s) => ({ key: s.manifest.id, title: skinName(t, s), detail: skinDescription(t, s) })),
    ];

    return (
        <Dialog open={!onboarded} onOpenChange={(o) => !o && finish()}>
            <DialogContent size="lg" className="ob overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t("shell.tour.title")}</DialogTitle>
                    <DialogDescription aria-live="polite">{t("shell.tour.step", { n: step + 1, total: STEPS.length })}</DialogDescription>
                </DialogHeader>
                <div className="ob-steps" aria-hidden>
                    {STEPS.map((s, i) => (
                        <i key={s} data-on={i <= step} />
                    ))}
                </div>
                <motion.section key={key} initial={motionOK ? { opacity: 0, x: 16 } : false} animate={{ opacity: 1, x: 0 }} transition={{ duration: motionOK ? 0.18 : 0 }} className="ob-body">
                    {key === "from" && (
                        <Step title={t("shell.tour.from")} detail={t("shell.tour.fromDetail")} note={`${t("shell.tour.fromChange")} ${t("shell.tour.fromLegal")}`}>
                            <Choices
                                label={t("shell.tour.from")}
                                columns={2}
                                items={fromItems}
                                value={fromValue}
                                onPick={(k) => {
                                    const f = FROM.find((x) => x.key === k);
                                    if (f && hasSkin(f.skin)) setSkin(f.skin);
                                }}
                            />
                        </Step>
                    )}
                    {key === "layout" && (
                        <Step title={t("shell.tour.layout")} detail={t("shell.tour.layoutDetail")}>
                            <Choices label={t("shell.tour.layout")} columns={3} items={BUILTIN_LAYOUTS.map((l) => ({ key: l.id, title: layoutName(t, l) }))} value={activeLayout} onPick={setLayout} />
                        </Step>
                    )}
                    {key === "skin" && (
                        <Step title={t("shell.tour.skin")} detail={t("shell.tour.skinDetail")}>
                            <Choices label={t("shell.tour.skin")} columns={3} items={skinItems} value={activeSkin ?? ""} onPick={(k) => setSkin(k === "" ? null : k)} />
                        </Step>
                    )}
                    {key === "controller" && (
                        <Step title={t("shell.tour.controller")} detail={t("shell.tour.controllerDetail")}>
                            <Button
                                variant="outline"
                                className="justify-self-start"
                                onClick={() => {
                                    finish();
                                    useUiStore.getState().openSettings("controllers");
                                }}
                            >
                                {t("shell.tour.openControllers")}
                            </Button>
                        </Step>
                    )}
                </motion.section>
                <DialogFooter>
                    <Button variant="ghost" className="me-auto" onClick={finish}>
                        {t("shell.tour.skip")}
                    </Button>
                    {step > 0 && (
                        <Button variant="outline" onClick={() => setStep(step - 1)}>
                            {t("shell.tour.back")}
                        </Button>
                    )}
                    {step < STEPS.length - 1 ? <Button onClick={() => setStep(step + 1)}>{t("shell.tour.next")}</Button> : <Button onClick={finish}>{t("shell.tour.done")}</Button>}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
