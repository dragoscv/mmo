/**
 * Player OSD (WP16-32): title + S/E line, scrub bar (buffered / position / chapter ticks / intro + credits
 * markers, sprite thumbnail while scrubbing), elapsed / remaining / "ends at", control row. Purely
 * presentational; the Player owns state, keys and the focus scope (`rootRef` is the scope element).
 * Position updates move only transforms (scaleX fill, translateX knob) — no layout per timeupdate.
 */
import type { ReactNode, RefObject } from "react";
import { t } from "../../i18n/messages";
import { fmtClock } from "../../lib/format";
import { Icon, type IconName } from "../../ui";
import type { Markers } from "./data";
import { tilePosition, spriteTile, type SpriteGrid } from "./model";

export interface OsdButton {
    id: string;
    icon: IconName | "moon";
    label: string;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    /** Value shown under the label (e.g. current track). */
    value?: string;
}

export interface OsdProps {
    rootRef: RefObject<HTMLDivElement | null>;
    visible: boolean;
    title: string;
    line: string;
    badge?: ReactNode;
    time: number;
    duration: number;
    buffered: number;
    /** Pending scrub target (abs s) while the user holds ←/→. */
    pending: number | null;
    markers: Markers;
    sprite: { url: string; grid: SpriteGrid } | null;
    endsAt: string;
    buttons: OsdButton[];
    /** Skip pill (always visible while in the span, even with the OSD hidden). */
    skip: { label: string; onSkip: () => void } | null;
    children?: ReactNode;
}

const pct = (v: number, d: number) => (d > 0 ? Math.max(0, Math.min(1, v / d)) : 0);

function Moon() {
    return (
        <svg className="icon" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
    );
}

export function Osd(p: OsdProps) {
    const shown = p.pending ?? p.time;
    const pos = pct(shown, p.duration);
    const buf = pct(p.buffered, p.duration);
    const d = p.duration;
    const tile = p.sprite && p.pending !== null ? spriteTile(p.sprite.grid, p.pending) : null;
    return (
        <div ref={p.rootRef} className={`pl-osd${p.visible ? " is-visible" : ""}`} data-focus-scope="" data-testid="player-osd">
            <div className="pl-osd-top" aria-hidden={!p.visible}>
                <div className="pl-title">{p.title}</div>
                {p.line && <div className="pl-line">{p.line}</div>}
                {p.badge}
            </div>
            {p.skip && (
                <div className="pl-skip-wrap">
                    <button type="button" className="pl-skip" data-focusable="" data-focus-key="osd:skip" onClick={p.skip.onSkip} data-testid="player-skip">
                        <Icon name="fwd10" /> {p.skip.label}
                    </button>
                </div>
            )}
            <div className="pl-osd-bottom" aria-hidden={!p.visible}>
                <div className="pl-scrub" data-focusable="" tabIndex={-1} data-focus-key="osd:scrub" role="slider"
                    aria-label={t("pl.seekBar")} aria-valuemin={0} aria-valuemax={Math.round(d)} aria-valuenow={Math.round(shown)}
                    aria-valuetext={fmtClock(shown)}>
                    <div className="pl-track">
                        <div className="pl-fill pl-fill-buf" style={{ transform: `scaleX(${buf})` }} />
                        <div className="pl-fill pl-fill-pos" style={{ transform: `scaleX(${pos})` }} />
                        {p.markers.intro && d > 0 && (
                            <div className="pl-mark pl-mark-intro" style={{ left: `${pct(p.markers.intro.start, d) * 100}%`, width: `${(pct(p.markers.intro.end, d) - pct(p.markers.intro.start, d)) * 100}%` }} />
                        )}
                        {p.markers.recap && d > 0 && (
                            <div className="pl-mark pl-mark-intro" style={{ left: `${pct(p.markers.recap.start, d) * 100}%`, width: `${(pct(p.markers.recap.end, d) - pct(p.markers.recap.start, d)) * 100}%` }} />
                        )}
                        {p.markers.credits !== null && d > 0 && (
                            <div className="pl-mark pl-mark-credits" style={{ left: `${pct(p.markers.credits, d) * 100}%`, right: 0 }} />
                        )}
                        {d > 0 && p.markers.chapters.filter((c) => c.start > 1).map((c) => (
                            <div key={c.start} className="pl-tick" style={{ left: `${pct(c.start, d) * 100}%` }} />
                        ))}
                    </div>
                    <div className="pl-knob-rail" style={{ transform: `translateX(${pos * 100}%)` }}>
                        <div className="pl-knob" />
                        {p.pending !== null && (
                            <div className="pl-preview">
                                {tile !== null && p.sprite && (
                                    <div className="pl-thumb" style={{ backgroundImage: `url(${p.sprite.url})`, backgroundPosition: tilePosition(tile) }} />
                                )}
                                <div className="pl-preview-time">{fmtClock(p.pending)}</div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="pl-times">
                    <span>{fmtClock(shown)}</span>
                    <span className="pl-ends">{d > 0 ? t("pl.endsAt", { time: p.endsAt }) : ""}</span>
                    <span>{d > 0 ? `-${fmtClock(Math.max(0, d - shown))}` : ""}</span>
                </div>
                <div className="pl-controls" data-focus-row="osd-controls">
                    {p.buttons.map((b) => (
                        <button key={b.id} type="button" className={`pl-btn${b.active ? " is-active" : ""}`} data-focusable=""
                            data-focus-key={`osd:${b.id}`} data-testid={`osd-${b.id}`} aria-label={b.label} aria-pressed={b.active}
                            disabled={b.disabled} onClick={b.onClick}>
                            {b.icon === "moon" ? <Moon /> : <Icon name={b.icon} />}
                            <span className="pl-btn-cap" aria-hidden="true">{b.label}{b.value ? ` · ${b.value}` : ""}</span>
                        </button>
                    ))}
                </div>
            </div>
            {p.children}
        </div>
    );
}
