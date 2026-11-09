/**
 * First-run tour: pick a layout, a look, and connect a controller. Shown once
 * (shell prefs `onboarded`); re-openable from Settings → About. Every step is
 * live (choices apply immediately) and skippable.
 */
import { useState } from "react";
import { motion } from "motion/react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mmo/ui";
import { useLayoutStore } from "@/layout/layout-store";
import { BUILTIN_LAYOUTS } from "@/layout/presets";
import { BUILTIN_SKINS } from "@/packs/builtin-skins";
import { usePackStore } from "@/packs/pack-store";
import { useUiStore } from "@/state/ui-store";
import { useShellPrefs } from "./shell-prefs";
import { useMotionOK } from "./motion";
import { useT } from "@/i18n";

const STEPS = ["layout", "skin", "controller"] as const;

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

    return (
        <Dialog open={!onboarded} onOpenChange={(o) => !o && finish()}>
            <DialogContent size="lg" className="overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t("shell.tour.title")}</DialogTitle>
                    <DialogDescription>
                        {step + 1} / {STEPS.length}
                    </DialogDescription>
                </DialogHeader>
                <motion.section
                    key={key}
                    initial={motionOK ? { opacity: 0, x: 24 } : false}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: motionOK ? 0.2 : 0 }}
                    className="grid gap-3"
                    aria-live="polite"
                >
                        {key === "layout" && (
                            <>
                                <h3 className="font-heading text-lg">{t("shell.tour.layout")}</h3>
                                <p className="text-sm text-muted-foreground">{t("shell.tour.layoutDetail")}</p>
                                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("shell.tour.layout")}>
                                    {BUILTIN_LAYOUTS.map((l) => (
                                        <button
                                            key={l.id}
                                            type="button"
                                            role="radio"
                                            aria-checked={activeLayout === l.id}
                                            onClick={() => setLayout(l.id)}
                                            className={"rounded-lg border p-3 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none " + (activeLayout === l.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}
                                        >
                                            {l.name}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                        {key === "skin" && (
                            <>
                                <h3 className="font-heading text-lg">{t("shell.tour.skin")}</h3>
                                <p className="text-sm text-muted-foreground">{t("shell.tour.skinDetail")}</p>
                                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("shell.tour.skin")}>
                                    {[null, ...BUILTIN_SKINS].map((s) => {
                                        const id = s?.manifest.id ?? null;
                                        return (
                                            <button
                                                key={id ?? "default"}
                                                type="button"
                                                role="radio"
                                                aria-checked={activeSkin === id}
                                                onClick={() => setSkin(id)}
                                                className={"rounded-lg border p-3 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none " + (activeSkin === id ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}
                                            >
                                                <span className="block text-sm font-medium">{s?.manifest.name ?? "MixAI"}</span>
                                                {s && <span className="block text-xs text-muted-foreground">{s.manifest.description}</span>}
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                        {key === "controller" && (
                            <>
                                <h3 className="font-heading text-lg">{t("shell.tour.controller")}</h3>
                                <p className="text-sm text-muted-foreground">{t("shell.tour.controllerDetail")}</p>
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
                            </>
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
