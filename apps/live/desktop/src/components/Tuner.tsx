/** Tuner strip: detected note + cents needle (from meters.tune), animated on the shared rAF loop. */
import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { frameLoop } from "../lib/meter-bus";
import { noteName } from "../lib/protocol";

export function TunerStrip() {
    const t = useT();
    const needle = useRef<HTMLDivElement>(null);
    const note = useRef<HTMLSpanElement>(null);
    const detail = useRef<HTMLSpanElement>(null);
    const idleText = t("tuner.idle");
    const targetFmt = t("tuner.target", { note: "%N" });
    const corrFmt = t("tuner.correction", { cents: "%C" });

    useEffect(() => {
        let pos = 0;
        let shown = "";
        return frameLoop((m, dt) => {
            const tune = m?.tune;
            const voiced = !!tune && tune.freq > 0 && tune.midi > 0;
            const cents = voiced ? Math.max(-50, Math.min(50, tune.cents)) : 0;
            const k = Math.min(1, dt * 14);
            pos += (cents - pos) * k;
            if (needle.current) {
                needle.current.style.left = `${50 + pos}%`;
                needle.current.dataset.state = !voiced ? "idle" : Math.abs(cents) < 5 ? "in" : Math.abs(cents) < 20 ? "near" : "off";
            }
            const label = voiced ? noteName(tune.midi) : "–";
            const info = voiced
                ? `${tune.target >= 0 ? targetFmt.replace("%N", noteName(tune.target)) : ""}${
                      Math.abs(tune.correction_cents) >= 1 ? ` · ${corrFmt.replace("%C", String(Math.round(tune.correction_cents)))}` : ""
                  }`
                : idleText;
            const key = label + info;
            if (key !== shown) {
                shown = key;
                if (note.current) note.current.textContent = label;
                if (detail.current) detail.current.textContent = info;
            }
        });
    }, [idleText, targetFmt, corrFmt]);

    return (
        <section aria-label={t("tuner.title")} className="surface flex items-center gap-4 rounded-2xl px-4 py-2">
            <span ref={note} className="w-14 text-center font-heading text-3xl font-semibold tabular-nums" aria-live="off">
                –
            </span>
            <div className="relative h-8 flex-1" role="img" aria-label={t("tuner.needle")}>
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                {[-50, -25, 0, 25, 50].map((c) => (
                    <div
                        key={c}
                        className={c === 0 ? "absolute top-0 h-full w-0.5 -translate-x-1/2 bg-success/60" : "absolute top-2 h-4 w-px -translate-x-1/2 bg-muted-foreground/40"}
                        style={{ left: `${50 + c}%` }}
                    />
                ))}
                <div
                    ref={needle}
                    data-state="idle"
                    className="absolute top-0 left-1/2 h-full w-1.5 -translate-x-1/2 rounded-full transition-colors duration-(--dur-fast) data-[state=idle]:bg-muted-foreground/30 data-[state=in]:bg-success data-[state=near]:bg-warning data-[state=off]:bg-destructive"
                />
            </div>
            <span ref={detail} className="w-48 truncate text-right text-xs text-muted-foreground tabular-nums">
                {idleText}
            </span>
        </section>
    );
}
