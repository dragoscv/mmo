/** Lightweight notices (errors / confirmations) in a polite live region. */
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@mmo/ui";
import { useT } from "../i18n";
import { useStore } from "../store";

const ICON = { error: XCircle, success: CheckCircle2, info: Info };
const TONE = { error: "border-l-destructive", success: "border-l-success", info: "border-l-info" };
const ICON_TONE = { error: "text-destructive", success: "text-success", info: "text-info" };

export function Notices() {
    const t = useT();
    const notices = useStore((s) => s.notices);
    const dismiss = useStore((s) => s.dismiss);
    return (
        <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-(--z-toast) flex w-96 flex-col gap-2">
            <AnimatePresence initial={false}>
                {notices.map((n) => {
                    const Icon = ICON[n.kind];
                    return (
                        <motion.div
                            key={n.id}
                            layout
                            initial={{ opacity: 0, x: 24 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 24 }}
                            role={n.kind === "error" ? "alert" : "status"}
                            className={cn("surface pointer-events-auto flex items-start gap-3 rounded-lg border-l-4 p-3 text-sm", TONE[n.kind])}
                        >
                            <Icon className={cn("mt-0.5 size-4 shrink-0", ICON_TONE[n.kind])} aria-hidden />
                            <p className="flex-1">{t(n.key, n.vars ?? {})}</p>
                            <button
                                type="button"
                                aria-label={t("chain.close")}
                                onClick={() => dismiss(n.id)}
                                className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
                            >
                                <X className="size-4" />
                            </button>
                        </motion.div>
                    );
                })}
            </AnimatePresence>
        </div>
    );
}
