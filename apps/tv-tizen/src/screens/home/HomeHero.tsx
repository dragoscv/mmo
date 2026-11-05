/**
 * Home hero: follows the focused card (debounced by the caller), shows the TMDB logo (from `/media/title`, cached),
 * chips, 3-line overview, and Play/Resume · More info · My list. Details load lazily; the card data renders first.
 */
import { useEffect, useState } from "react";
import type { MediaTitleResponse, TitleCard } from "../../lib/media-types";
import type { ScreenCtx } from "../../nav/ctx";
import { t } from "../../i18n/messages";
import { PrimaryButton, SecondaryButton } from "../../ui";
import { cardKey, playLabel, previewTarget, resolveTarget, startPlayback, titleChips } from "./media-ui";
import { HeroText, rememberFlipSource } from "./widgets";

export function HomeHero({ ctx, card }: { ctx: ScreenCtx; card: TitleCard | null }) {
    const [det, setDet] = useState<{ key: string; d: MediaTitleResponse | null } | null>(null);
    const [inList, setInList] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const key = card ? cardKey(card) : "";

    useEffect(() => {
        if (!card) return;
        let alive = true;
        setErr(null);
        ctx.media.mediaTitle(card.kind, card.tmdbId)
            .then((d) => { if (alive) { setDet({ key: cardKey(card), d }); setInList(d?.inWatchlist ?? null); } })
            .catch(() => { if (alive) setDet({ key: cardKey(card), d: null }); });
        return () => { alive = false; };
    }, [ctx.media, card]);

    if (!card) return null;
    const d = det && det.key === key ? det.d : null;
    const logo = d?.title.logoPath ? ctx.media.imageFor(d.title.logoPath, 520) : null;
    const tg = d ? previewTarget(d) : null;
    const pl = playLabel(tg);
    const canPlay = !!tg || (card.progress ?? 0) > 0 || !!card.nextEpisode;
    const open = () => { rememberFlipSource("", null); ctx.nav.push({ name: "title", kind: card.kind, tmdbId: card.tmdbId, seed: card }); };

    const play = async () => {
        setBusy(true); setErr(null);
        try {
            const data = d ?? (await ctx.media.mediaTitle(card.kind, card.tmdbId));
            const target = data ? await resolveTarget(ctx, data) : null;
            if (!target) { open(); return; }
            await startPlayback(ctx, target);
        } catch (e) {
            setErr(t("wh.playError", { message: (e as Error).message }));
        } finally { setBusy(false); }
    };

    const toggleList = async () => {
        const next = !(inList ?? false);
        setInList(next);
        try {
            if (next) await ctx.media.watchlistAdd(card.kind, card.tmdbId);
            else await ctx.media.watchlistRemove(card.kind, card.tmdbId);
        } catch { setInList(!next); }
    };

    return (
        <div data-testid="home-hero" data-hero={key}>
            <HeroText logo={logo} name={card.title} chips={titleChips(card, d)} overview={d?.title.overview || card.overview} />
            <div className="wh-actions" data-focus-row="hero-actions">
                {canPlay
                    ? <PrimaryButton icon="play" label={pl.label} sub={pl.sub} focusKey="hero:play" testId="hero-play" disabled={busy} onClick={() => { void play(); }} />
                    : <PrimaryButton icon="info" label={t("wh.moreInfo")} focusKey="hero:info" testId="hero-info" onClick={open} />}
                {canPlay && <SecondaryButton icon="info" label={t("wh.moreInfo")} focusKey="hero:info" testId="hero-info" onClick={open} />}
                <SecondaryButton icon={inList ? "check" : "plus"} label={inList ? t("wh.inMyList") : t("wh.myList")} active={!!inList}
                    focusKey="hero:list" testId="hero-list" onClick={() => { void toggleList(); }} />
            </div>
            <div className={`wh-status${err ? " is-error" : ""}`}>{busy ? t("common.loading") : err}</div>
        </div>
    );
}
