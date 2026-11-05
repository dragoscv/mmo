"use client";

/**
 * Player overlays rendered INSIDE the player root (so they stay visible in element fullscreen, where
 * portalled popovers would not): side sheet, radio lists, Up Next card, "Still watching?" dialog, chat bubbles.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Check, Play, X } from "lucide-react";

export function SidePanel({ title, onClose, children, labelledBy }: { title: string; onClose(): void; children: ReactNode; labelledBy: string }) {
    const t = useTranslations("mx.player.panel");
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const prev = document.activeElement as HTMLElement | null;
        const first = ref.current?.querySelector<HTMLElement>('[aria-checked="true"], button, input, [tabindex="0"]');
        first?.focus();
        return () => { if (prev && document.contains(prev)) prev.focus(); };
    }, []);
    // Keep Tab inside the sheet.
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Tab") return;
        const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, [tabindex="0"]') ?? []);
        if (els.length === 0) return;
        const first = els[0]!, last = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    return (
        <div ref={ref} className="mxp-panel" role="dialog" aria-modal="false" aria-labelledby={labelledBy} onKeyDown={onKey} data-mxp-keep>
            <div className="mxp-panel-head">
                <h2 id={labelledBy} className="mxp-panel-title">{title}</h2>
                <button type="button" className="mxp-icon-btn" onClick={onClose} aria-label={t("close")}>
                    <X aria-hidden className="size-5" />
                </button>
            </div>
            <div className="mxp-panel-body">{children}</div>
        </div>
    );
}

export interface RadioOption<V extends string | number> { value: V; label: string; hint?: string }

/** Roving radiogroup (↑/↓ move + select, Home/End). */
export function RadioList<V extends string | number>({ label, options, value, onChange }: {
    label: string; options: ReadonlyArray<RadioOption<V>>; value: V; onChange(v: V): void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const i = options.findIndex((o) => o.value === value);
        let n = -1;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") n = Math.min(options.length - 1, i + 1);
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") n = Math.max(0, i - 1);
        else if (e.key === "Home") n = 0;
        else if (e.key === "End") n = options.length - 1;
        if (n < 0 || n === i) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(options[n]!.value);
        requestAnimationFrame(() => ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[n]?.focus());
    };
    return (
        <div className="mxp-section">
            <h3 className="mxp-section-title">{label}</h3>
            <div ref={ref} role="radiogroup" aria-label={label} className="mxp-radios" onKeyDown={onKey}>
                {options.map((o) => {
                    const on = o.value === value;
                    return (
                        <button key={String(o.value)} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
                            className="mxp-radio" onClick={() => onChange(o.value)}>
                            <Check aria-hidden className="mxp-radio-check size-4" />
                            <span className="mxp-radio-label">{o.label}</span>
                            {o.hint && <span className="mxp-radio-hint">{o.hint}</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function UpNextCard({ name, label, stillUrl, countdown, onPlay, onCancel }: {
    name: string; label: string; stillUrl: string | null; countdown: number | null; onPlay(): void; onCancel(): void;
}) {
    const t = useTranslations("mx.player.upNext");
    const playRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { playRef.current?.focus({ preventScroll: true }); }, []);
    return (
        <section className="mxp-upnext" aria-labelledby="mxp-upnext-title" data-mxp-keep>
            {stillUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- server-proxied TMDB still
                <img src={stillUrl} alt="" className="mxp-upnext-still" />
            )}
            <div className="mxp-upnext-body">
                <p className="mxp-upnext-kicker" id="mxp-upnext-title">{t("title")}</p>
                <p className="mxp-upnext-label">{label}</p>
                <p className="mxp-upnext-name">{name}</p>
                <p className="mxp-upnext-count" aria-live="polite">
                    {countdown !== null ? t("countdown", { seconds: countdown }) : "\u00a0"}
                </p>
                <div className="mxp-upnext-actions">
                    <button ref={playRef} type="button" className="mxp-btn mxp-btn-primary" onClick={onPlay}>
                        <Play aria-hidden className="size-4" />{t("playNow")}
                    </button>
                    <button type="button" className="mxp-btn" onClick={onCancel}>{t("cancel")}</button>
                </div>
            </div>
        </section>
    );
}

export function StillWatching({ onContinue, onExit }: { onContinue(): void; onExit(): void }) {
    const t = useTranslations("mx.player.still");
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => { ref.current?.focus(); }, []);
    return (
        <div className="mxp-modal-scrim" data-mxp-keep>
            <div className="mxp-modal" role="alertdialog" aria-modal="true" aria-labelledby="mxp-still-title" aria-describedby="mxp-still-body">
                <h2 id="mxp-still-title" className="mxp-modal-title">{t("title")}</h2>
                <p id="mxp-still-body" className="mxp-modal-body">{t("body")}</p>
                <div className="mxp-modal-actions">
                    <button ref={ref} type="button" className="mxp-btn mxp-btn-primary" onClick={onContinue}>{t("continue")}</button>
                    <button type="button" className="mxp-btn" onClick={onExit}>{t("exit")}</button>
                </div>
            </div>
        </div>
    );
}

export interface Bubble { id: number; text: string; kind: "chat" | "react" }

export function Bubbles({ items }: { items: Bubble[] }) {
    if (items.length === 0) return null;
    return (
        <div className="mxp-bubbles" aria-live="polite">
            {items.map((b) => (
                <div key={b.id} className="mxp-bubble" data-kind={b.kind}>{b.text}</div>
            ))}
        </div>
    );
}
