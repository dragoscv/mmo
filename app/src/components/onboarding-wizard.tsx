"use client";

/**
 * Onboarding wizard — 4 steps a brand-new user needs to clear before
 * MMO is useful: pick a language, sign in, install the companion app,
 * run their first scan. Auto-opens on /dashboard when the user has zero
 * tracks and hasn't dismissed it; reopenable from the command palette.
 *
 * Sign-in step is auto-completed when a session exists. Companion step
 * is auto-completed when the dashboard tells us a companion is linked
 * (we infer "linked" from `hasCompanion`, which the parent passes).
 *
 * State is dead-simple: a stepIndex in component state and a single
 * localStorage flag (`mmo.onboarding.dismissed`) to remember the user
 * said "skip for now". When the user hits the last step's CTA they're
 * routed to the scanner; we persist the dismissal at the same time.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
    Languages, LogIn, MonitorDown, ScanSearch, Check, ArrowRight, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { setLocaleAction } from "@/actions/locale";
import { SUPPORTED_LOCALES, type AppLocale } from "@/i18n/locales";

const DISMISS_KEY = "mmo.onboarding.dismissed";

type StepKey = "lang" | "auth" | "companion" | "scan";

interface Step {
    key: StepKey;
    title: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    /** Optional auto-completion check. */
    autoDone?: () => boolean;
}

interface Props {
    /** Current locale, used to mark the language step done if the
     *  user already has a non-default cookie. */
    currentLocale: AppLocale;
    /** True when the user is signed in. */
    isAuthed: boolean;
    /** True when a companion is linked. */
    hasCompanion: boolean;
    /** True when the library has at least one track — implies the user
     *  has already done a scan, so we can skip the wizard entirely. */
    hasTracks: boolean;
}

export function OnboardingWizard({ currentLocale, isAuthed, hasCompanion, hasTracks }: Props) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<StepKey>("lang");
    const [picking, startTransition] = useTransition();

    // Open on mount when the user has nothing yet and hasn't dismissed.
    useEffect(() => {
        if (hasTracks) return;
        let dismissed = false;
        try { dismissed = localStorage.getItem(DISMISS_KEY) === "1"; } catch { /* noop */ }
        if (dismissed) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount decision
        setOpen(true);
        // Skip ahead past steps that are already satisfied.
        if (isAuthed) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount decision
            setStep(hasCompanion ? "scan" : "companion");
        }
    }, [hasTracks, isAuthed, hasCompanion]);

    function dismiss() {
        try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* noop */ }
        setOpen(false);
    }

    function pickLocale(loc: AppLocale) {
        startTransition(() => {
            setLocaleAction(loc);
            setStep("auth");
        });
    }

    function next() {
        const order: StepKey[] = ["lang", "auth", "companion", "scan"];
        const idx = order.indexOf(step);
        if (idx < order.length - 1) setStep(order[idx + 1]);
    }

    function finish() {
        dismiss();
        router.push("/scanner");
    }

    if (hasTracks) return null;

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) dismiss(); }}>
            <DialogContent className="max-w-xl gap-0 p-0 overflow-hidden">
                <DialogHeader className="p-6 pb-4 border-b border-border/50">
                    <DialogTitle className="text-lg">Welcome to MMO</DialogTitle>
                    <DialogDescription>
                        Four quick steps and your DJ library is ready.
                    </DialogDescription>
                </DialogHeader>

                <Stepper current={step} isAuthed={isAuthed} hasCompanion={hasCompanion} />

                <div className="p-6 min-h-[220px]">
                    {step === "lang" && (
                        <LanguageStep
                            current={currentLocale}
                            picking={picking}
                            onPick={pickLocale}
                        />
                    )}
                    {step === "auth" && (
                        <AuthStep isAuthed={isAuthed} onContinue={next} />
                    )}
                    {step === "companion" && (
                        <CompanionStep hasCompanion={hasCompanion} onContinue={next} onJump={() => router.push("/download")} />
                    )}
                    {step === "scan" && (
                        <ScanStep onFinish={finish} />
                    )}
                </div>

                <DialogFooter className="border-t border-border/50 px-6 py-3 flex items-center justify-between">
                    <button
                        type="button"
                        onClick={dismiss}
                        className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    >
                        <X className="h-3 w-3" /> Skip for now
                    </button>
                    <span className="text-[11px] text-muted-foreground/60">
                        You can re-open this from <kbd className="rounded border border-border/50 px-1 py-0.5 font-mono">⌘K</kbd> → "Onboarding"
                    </span>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Stepper({
    current, isAuthed, hasCompanion,
}: { current: StepKey; isAuthed: boolean; hasCompanion: boolean }) {
    const steps: { key: StepKey; label: string; done: boolean }[] = [
        { key: "lang", label: "Language", done: false },
        { key: "auth", label: "Sign in", done: isAuthed },
        { key: "companion", label: "Companion", done: hasCompanion },
        { key: "scan", label: "Scan", done: false },
    ];
    const order: StepKey[] = steps.map(s => s.key);
    const currentIdx = order.indexOf(current);
    return (
        <div className="flex items-stretch border-b border-border/50">
            {steps.map((s, i) => {
                const isCurrent = s.key === current;
                const isPast = i < currentIdx || s.done;
                return (
                    <div
                        key={s.key}
                        className={cn(
                            "flex-1 flex items-center gap-2 px-4 py-2.5 text-xs",
                            isCurrent ? "bg-primary/5 text-foreground font-medium" : "text-muted-foreground",
                            i < steps.length - 1 && "border-r border-border/30",
                        )}
                    >
                        <span className={cn(
                            "h-5 w-5 rounded-full grid place-items-center text-[10px] font-mono",
                            isPast ? "bg-emerald-500/20 text-emerald-300" :
                            isCurrent ? "bg-primary/20 text-primary" :
                            "bg-muted/50 text-muted-foreground/60",
                        )}>
                            {isPast ? <Check className="h-3 w-3" /> : i + 1}
                        </span>
                        {s.label}
                    </div>
                );
            })}
        </div>
    );
}

function LanguageStep({
    current, picking, onPick,
}: { current: AppLocale; picking: boolean; onPick: (l: AppLocale) => void }) {
    const labels: Record<AppLocale, string> = { ro: "Română", en: "English" };
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted/50 grid place-items-center">
                    <Languages className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                    <h3 className="text-base font-medium">Pick your language</h3>
                    <p className="text-xs text-muted-foreground">You can change this later in Settings.</p>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
                {SUPPORTED_LOCALES.map((loc) => {
                    const isCurrent = loc === current;
                    return (
                        <button
                            key={loc}
                            type="button"
                            disabled={picking}
                            onClick={() => onPick(loc)}
                            className={cn(
                                "p-4 rounded-lg border text-left transition-all",
                                isCurrent
                                    ? "border-primary bg-primary/10"
                                    : "border-border hover:bg-muted/30",
                                picking && "opacity-60 cursor-progress",
                            )}
                        >
                            <div className="text-sm font-medium">{labels[loc]}</div>
                            <div className="text-xs text-muted-foreground">{loc.toUpperCase()}</div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function AuthStep({ isAuthed, onContinue }: { isAuthed: boolean; onContinue: () => void }) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted/50 grid place-items-center">
                    <LogIn className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                    <h3 className="text-base font-medium">Sign in</h3>
                    <p className="text-xs text-muted-foreground">Your library, playlists, and settings sync across devices.</p>
                </div>
            </div>
            {isAuthed ? (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 flex items-center gap-3">
                    <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span className="text-sm text-foreground">You're signed in.</span>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={onContinue}>
                        Continue <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                </div>
            ) : (
                <div className="rounded-lg border border-border p-4 space-y-3">
                    <p className="text-sm text-muted-foreground">
                        Click below to sign in. We'll bring you right back to this wizard.
                    </p>
                    <Button asChild className="w-full">
                        <a href="/login">Sign in</a>
                    </Button>
                </div>
            )}
        </div>
    );
}

function CompanionStep({
    hasCompanion, onContinue, onJump,
}: { hasCompanion: boolean; onContinue: () => void; onJump: () => void }) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted/50 grid place-items-center">
                    <MonitorDown className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                    <h3 className="text-base font-medium">Install the companion</h3>
                    <p className="text-xs text-muted-foreground">A small desktop app that scans your local files.</p>
                </div>
            </div>
            {hasCompanion ? (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 flex items-center gap-3">
                    <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span className="text-sm">Companion linked.</span>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={onContinue}>
                        Continue <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                </div>
            ) : (
                <div className="rounded-lg border border-border p-4 space-y-3">
                    <p className="text-sm text-muted-foreground">
                        Download MMO Companion for your OS, run it once, and link it to this account.
                    </p>
                    <div className="flex gap-2">
                        <Button onClick={onJump} className="flex-1">
                            Open downloads
                        </Button>
                        <Button variant="ghost" onClick={onContinue}>
                            I'll do it later
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

function ScanStep({ onFinish }: { onFinish: () => void }) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted/50 grid place-items-center">
                    <ScanSearch className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                    <h3 className="text-base font-medium">Run your first scan</h3>
                    <p className="text-xs text-muted-foreground">Point MMO at a folder of audio files. We'll handle the rest.</p>
                </div>
            </div>
            <div className="rounded-lg border border-border p-4 space-y-3">
                <p className="text-sm text-muted-foreground">
                    Scanner reads ID3 tags, computes BPM + Camelot key, and indexes everything for instant search.
                </p>
                <Button onClick={onFinish} className="w-full">
                    Open Scanner <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
            </div>
        </div>
    );
}
