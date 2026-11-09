/**
 * Floating bar while a skin is being tried (30 s): countdown, Keep / Revert,
 * progress line. Announced politely only at start, at 10 s and at the end so
 * screen readers are not flooded every second. Esc inside the bar = revert.
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Undo2 } from "lucide-react";
import { Button } from "@mmo/ui";
import { useT } from "@/i18n";
import { useMotionOK } from "@/shell/motion";
import { TRY_MS, usePackStore } from "./pack-store";

export function TryBanner() {
    const t = useT();
    const trying = usePackStore((s) => s.trying);
    const motionOK = useMotionOK();
    const [now, setNow] = useState(() => Date.now());
    const [announce, setAnnounce] = useState("");
    const announced10 = useRef(false);
    const wasTrying = useRef<string | null>(null);

    useEffect(() => {
        if (!trying) {
            if (wasTrying.current) setAnnounce(t("pack.tryEnd"));
            wasTrying.current = null;
            return;
        }
        wasTrying.current = trying.pack.manifest.id;
        announced10.current = false;
        setNow(Date.now());
        setAnnounce(t("pack.tryAnnounce", { name: trying.pack.manifest.name, s: Math.round(TRY_MS / 1000) }));
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [trying, t]);

    const left = trying ? Math.max(0, Math.ceil((trying.endsAt - now) / 1000)) : 0;
    useEffect(() => {
        if (trying && left <= 10 && left > 0 && !announced10.current) {
            announced10.current = true;
            setAnnounce(t("pack.try10"));
        }
    }, [left, trying, t]);

    const keep = () => void usePackStore.getState().keepTry();
    const revert = () => usePackStore.getState().endTry();
    const fraction = trying ? Math.max(0, Math.min(1, (trying.endsAt - now) / TRY_MS)) : 0;

    return (
        <>
            <p role="status" aria-live="polite" className="sr-only">
                {announce}
            </p>
            {trying ? (
                <div
                    role="region"
                    aria-label={t("pack.bannerLabel")}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            e.stopPropagation();
                            revert();
                        }
                    }}
                    className="surface fixed top-12 left-1/2 z-(--z-overlay) w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border shadow-lg"
                >
                    <div className="flex items-center gap-3 px-3 py-2">
                        <p className="min-w-0 flex-1 truncate text-sm">
                            <span className="font-medium">{t("pack.trying", { name: trying.pack.manifest.name })}</span>
                            <span className="mono ml-2 text-muted-foreground tabular-nums">{t("pack.seconds", { s: left })}</span>
                        </p>
                        <Button size="sm" onClick={keep}>
                            <Check aria-hidden /> {t("pack.keep")}
                        </Button>
                        <Button size="sm" variant="outline" onClick={revert}>
                            <Undo2 aria-hidden /> {t("pack.revert")}
                        </Button>
                    </div>
                    <div aria-hidden className="h-0.5 bg-muted">
                        {motionOK ? (
                            <motion.div
                                key={trying.endsAt}
                                className="h-full origin-left bg-primary"
                                initial={{ scaleX: fraction }}
                                animate={{ scaleX: 0 }}
                                transition={{ duration: fraction * (TRY_MS / 1000), ease: "linear" }}
                            />
                        ) : (
                            <div className="h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
                        )}
                    </div>
                </div>
            ) : null}
        </>
    );
}
