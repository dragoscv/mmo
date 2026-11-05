/**
 * Player overlays that are not plain choice lists: Info sheet, Up Next card, reactions + chat toasts.
 * Choice lists (audio, subtitles, speed, format, sleep) use the kit's `<SidePanel>`.
 */
import { useEffect, useRef } from "react";
import { t } from "../../i18n/messages";
import { useBackHandler } from "../../nav/back";
import { PrimaryButton, SecondaryButton, useFocusScope } from "../../ui";
import type { NextEpisode } from "./data";

export function InfoSheet({ rows, onClose }: { rows: Array<[string, string]>; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useFocusScope(ref, true);
    useBackHandler(() => { onClose(); }, true);
    return (
        <div className="overlay overlay-side" role="presentation">
            <div ref={ref} className="sidepanel pl-info" role="dialog" aria-modal="true" aria-labelledby="pl-info-title" data-focus-scope="" data-testid="player-info">
                <h2 id="pl-info-title" className="sidepanel-title">{t("pl.info")}</h2>
                <dl className="pl-info-list">
                    {rows.filter(([, v]) => !!v).map(([k, v]) => (
                        <div key={k} className="pl-info-row"><dt>{k}</dt><dd>{v}</dd></div>
                    ))}
                </dl>
                <SecondaryButton label={t("common.close")} onClick={onClose} focusKey="info:close" />
            </div>
        </div>
    );
}

export function UpNextCard({ next, countdown, onPlay, onCancel }: {
    next: NextEpisode; countdown: number | null; onPlay: () => void; onCancel: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useFocusScope(ref, true);
    useBackHandler(() => { onCancel(); }, true);
    useEffect(() => {
        const h = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[data-focus-key="upnext:play"]')?.focus());
        return () => cancelAnimationFrame(h);
    }, []);
    return (
        <div ref={ref} className="pl-upnext" role="dialog" aria-label={t("pl.upNext")} data-focus-scope="" data-testid="player-upnext">
            <div className="pl-upnext-still" style={next.still ? { backgroundImage: `url(${next.still})` } : undefined} />
            <div className="pl-upnext-body">
                <div className="pl-upnext-kicker">{countdown !== null ? t("pl.upNextIn", { n: countdown }) : t("pl.upNext")}</div>
                <div className="pl-upnext-title">{`S${next.season}E${next.episode}${next.name ? ` · ${next.name}` : ""}`}</div>
                <div className="pl-upnext-actions" data-focus-row="upnext">
                    <PrimaryButton icon="play" label={t("pl.playNow")} onClick={onPlay} focusKey="upnext:play" testId="upnext-play" />
                    <SecondaryButton label={t("common.cancel")} onClick={onCancel} focusKey="upnext:cancel" testId="upnext-cancel" />
                </div>
            </div>
            {countdown !== null && <div className="pl-upnext-bar" style={{ animationDuration: "10s" }} />}
        </div>
    );
}

export interface Bubble { id: number; text: string; kind: "chat" | "react" }

export function Bubbles({ items }: { items: Bubble[] }) {
    const reacts = items.filter((b) => b.kind === "react");
    const chats = items.filter((b) => b.kind === "chat");
    return (
        <>
            <div className="pl-reacts" aria-live="polite">
                {reacts.map((b, i) => <div key={b.id} className="pl-react" style={{ left: `${10 + ((b.id * 37 + i * 13) % 70)}%` }}>{b.text}</div>)}
            </div>
            <div className="pl-chats" aria-live="polite">
                {chats.slice(-4).map((b) => <div key={b.id} className="pl-chat">{b.text}</div>)}
            </div>
        </>
    );
}
