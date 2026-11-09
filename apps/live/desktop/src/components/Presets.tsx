/** Presets bar: one-click recall (load_preset) + "save as" (save_preset). */
import { useState, type FormEvent } from "react";
import { motion } from "motion/react";
import { Save } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, cn } from "@mmo/ui";
import { useT } from "../i18n";
import { EMPTY_CHAIN, useStore } from "../store";

export function PresetsBar() {
    const t = useT();
    const presets: string[] = useStore((s) => s.proto.state?.presets ?? EMPTY_CHAIN);
    const current = useStore((s) => s.proto.state?.preset ?? "");
    const send = useStore((s) => s.send);
    const notify = useStore((s) => s.notify);
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");

    const save = (e: FormEvent) => {
        e.preventDefault();
        const n = name.trim();
        if (!n) return;
        send({ type: "save_preset", name: n });
        notify("success", "presets.saved", { name: n });
        setOpen(false);
    };

    return (
        <section aria-label={t("presets.title")} className="flex min-w-0 items-center gap-2">
            <h2 className="sr-only">{t("presets.title")}</h2>
            <div role="radiogroup" aria-label={t("presets.title")} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1">
                {presets.map((p) => {
                    const active = p === current;
                    return (
                        <button
                            key={p}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => send({ type: "load_preset", name: p })}
                            className={cn(
                                "relative shrink-0 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap outline-none transition-colors duration-(--dur-fast) focus-visible:ring-3 focus-visible:ring-ring/40",
                                active ? "text-primary-foreground" : "bg-muted text-foreground hover:bg-muted/70",
                            )}
                        >
                            {active ? <motion.span layoutId="preset-pill" className="absolute inset-0 rounded-full bg-primary" transition={{ type: "spring", stiffness: 420, damping: 34 }} /> : null}
                            <span className="relative">{p}</span>
                        </button>
                    );
                })}
            </div>
            <Button
                variant="outline"
                size="sm"
                title={t("presets.saveTitle")}
                disabled={presets.length === 0}
                onClick={() => {
                    setName(current);
                    setOpen(true);
                }}
            >
                <Save /> {t("presets.save")}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent size="sm">
                    <form onSubmit={save} className="flex flex-col gap-4">
                        <DialogHeader>
                            <DialogTitle>{t("presets.save")}</DialogTitle>
                            <DialogDescription>{t("presets.saveTitle")}</DialogDescription>
                        </DialogHeader>
                        <label className="flex flex-col gap-1.5 text-sm">
                            {t("presets.name")}
                            <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                        </label>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                                {t("presets.cancel")}
                            </Button>
                            <Button type="submit" disabled={!name.trim()}>
                                {t("presets.saveConfirm")}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </section>
    );
}

/** Tap tempo button with the current BPM. */
export function TapTempo() {
    const t = useT();
    const bpm = useStore((s) => s.proto.state?.bpm ?? null);
    const send = useStore((s) => s.send);
    const [pulse, setPulse] = useState(0);
    return (
        <Button
            variant="outline"
            className="relative w-32 overflow-hidden tabular-nums"
            aria-label={`${t("tap.label")} (T)`}
            onClick={() => {
                send({ type: "tap_tempo" });
                setPulse((p) => p + 1);
            }}
        >
            <motion.span
                key={pulse}
                aria-hidden
                className="absolute inset-0 bg-primary/25"
                initial={{ opacity: pulse ? 1 : 0 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.35 }}
            />
            <span className="relative">{bpm ? t("tap.bpm", { bpm: Math.round(bpm) }) : t("tap.none")}</span>
        </Button>
    );
}
