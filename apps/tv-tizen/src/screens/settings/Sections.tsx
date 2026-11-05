/**
 * Settings sections other than Profiles (WP16-33): Playback, Subtitles, Language, Navigation, Screen format,
 * Server, Account, Cache, Watch Together device name, About/diagnostics. Profile prefs are written with
 * `ctx.profiles.update(id, {prefs})` (server merges) and mirrored locally for the Player's first frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/messages";
import { useLocale } from "../../i18n/useLocale";
import { APP_VERSION } from "../../lib/device-auth";
import type { HubStatus } from "../../lib/hub";
import { clearLoaded } from "../../lib/image";
import { HOME_CACHE_PREFIX } from "../../lib/media";
import type { MediaStatus } from "../../lib/media-types";
import { NAV_IDS, navOrder, setNavOrder, type NavId } from "../../lib/prefs";
import { clearProgress } from "../../lib/progress";
import { squeezeFactor, useScreenFormat, type ScreenFormatKey } from "../../lib/screen-format";
import type { ScreenCtx } from "../../nav/ctx";
import { useBackHandler } from "../../nav/back";
import { Dialog, Icon, IconButton, Keyboard, PrimaryButton, SecondaryButton, SidePanel, useFocusScope, type IconName } from "../../ui";
import { DEFAULT_PREFS, LANGS, langName, PREF_KEYS, readPlayerPrefs, SUB_BGS, SUB_SIZES, type PlayerPrefs } from "../player/prefs";
import { mirrorPlayerPrefs } from "../player/usePlayerPrefs";
import { customDeviceName, readDeviceName, writeDeviceName } from "./device-name";
import { ChipRow, Note, Row, Section, ToggleRow } from "./parts";
import "../player/player.css";

// ─── profile prefs ─────────────────────────────────────────────────────────

function usePrefs(ctx: ScreenCtx): [PlayerPrefs, (key: keyof PlayerPrefs, v: unknown) => void, string | null] {
    const [prefs, setPrefs] = useState<PlayerPrefs>(() => (ctx.profiles.active ? readPlayerPrefs(ctx.profiles.active) : DEFAULT_PREFS));
    const [error, setError] = useState<string | null>(null);
    useEffect(() => ctx.profiles.changed.on((p) => { if (p) setPrefs(readPlayerPrefs(p)); }), [ctx.profiles]);
    const write = useCallback((key: keyof PlayerPrefs, v: unknown) => {
        const p = ctx.profiles.active;
        setPrefs((cur) => ({ ...cur, [key]: v }));
        if (!p) return;
        setError(null);
        ctx.profiles.update(p.id, { prefs: { [PREF_KEYS[key]]: v } })
            .then((np) => mirrorPlayerPrefs(np))
            .catch((e: Error) => { setError(t("set.saveFailed", { message: e.message })); setPrefs(readPlayerPrefs(p)); });
    }, [ctx.profiles]);
    return [prefs, write, error];
}

function NoProfile() { return <Note>{t("set.noActiveProfile")}</Note>; }

export function PlaybackSection({ ctx }: { ctx: ScreenCtx }) {
    const [prefs, write, error] = usePrefs(ctx);
    const [pick, setPick] = useState<"audio" | "sub" | null>(null);
    const langItems = (offLabel: string) => [{ id: "", label: offLabel }, ...LANGS.map((l) => ({ id: l.code, label: l.name }))];
    return (
        <Section title={t("set.playback")} sub={ctx.profiles.active ? t("set.forProfile", { name: ctx.profiles.active.name }) : undefined} testId="set-playback">
            {!ctx.profiles.active && <NoProfile />}
            <ToggleRow label={t("set.autoplayNext")} sub={t("set.autoplayNextSub")} checked={prefs.autoplayNext} onChange={(v) => write("autoplayNext", v)} focusKey="set:pb:autoplay" testId="set-autoplay" />
            <ToggleRow label={t("set.skipIntro")} sub={t("set.skipIntroSub")} checked={prefs.skipIntro} onChange={(v) => write("skipIntro", v)} focusKey="set:pb:skip" />
            <Row focusKey="set:pb:audio" icon="audio" chevron label={t("set.audioLang")} value={prefs.audioLang ? langName(prefs.audioLang) : t("set.fileDefault")} onClick={() => setPick("audio")} />
            <Row focusKey="set:pb:sub" icon="subtitles" chevron label={t("set.subLang")} value={prefs.subLang ? langName(prefs.subLang) : t("set.subAuto")} onClick={() => setPick("sub")} />
            <ToggleRow label={t("set.forcedOnly")} sub={t("set.forcedOnlySub")} checked={prefs.subForcedOnly} onChange={(v) => write("subForcedOnly", v)} focusKey="set:pb:forced" />
            {error && <Note tone="error">{error}</Note>}
            <SidePanel open={pick === "audio"} title={t("set.audioLang")} items={langItems(t("set.fileDefault"))} value={prefs.audioLang}
                onSelect={(id) => { write("audioLang", id); setPick(null); }} onClose={() => setPick(null)} />
            <SidePanel open={pick === "sub"} title={t("set.subLang")} items={langItems(t("set.subAuto"))} value={prefs.subLang}
                onSelect={(id) => { write("subLang", id); setPick(null); }} onClose={() => setPick(null)} />
        </Section>
    );
}

export function SubtitlesSection({ ctx }: { ctx: ScreenCtx }) {
    const [prefs, write, error] = usePrefs(ctx);
    return (
        <Section title={t("set.subtitles")} sub={t("set.subtitlesSub")} testId="set-subtitles">
            {!ctx.profiles.active && <NoProfile />}
            <ChipRow label={t("pl.subSize")} rowId="set-subsize" value={prefs.subSize}
                items={SUB_SIZES.map((s) => ({ id: s, label: t(`pl.size.${s}`) }))} onChange={(id) => write("subSize", id)} />
            <ChipRow label={t("pl.subBg")} rowId="set-subbg" value={prefs.subBg}
                items={SUB_BGS.map((b) => ({ id: b, label: t(`pl.bg.${b}`) }))} onChange={(id) => write("subBg", id)} />
            <div className={`set-subpreview pl-subs-${prefs.subSize} pl-subs-bg-${prefs.subBg}`} aria-hidden="true">
                <div className="pl-cue"><span>{t("set.subPreview")}</span></div>
            </div>
            {error && <Note tone="error">{error}</Note>}
        </Section>
    );
}

export function LanguageSection() {
    const [locale, setLocale] = useLocale();
    return (
        <Section title={t("set.language")} sub={t("set.languageSub")} testId="set-language">
            <ChipRow label={t("set.appLanguage")} rowId="set-lang" value={locale}
                items={[{ id: "ro", label: "Română" }, { id: "en", label: "English" }]}
                onChange={(id) => setLocale(id === "en" ? "en" : "ro")} />
        </Section>
    );
}

// ─── navigation order ──────────────────────────────────────────────────────

const NAV_ICON: Record<NavId, IconName> = { home: "home", search: "search", movies: "movie", shows: "tv", music: "music", livetv: "livetv", settings: "settings" };

export function NavigationSection() {
    const [order, setOrder] = useState<NavId[]>(() => navOrder());
    const hidden = NAV_IDS.filter((id) => !order.includes(id));
    const commit = (next: NavId[]) => { setOrder(next); setNavOrder(next); };
    const move = (id: NavId, d: -1 | 1) => {
        const i = order.indexOf(id), j = i + d;
        if (i < 0 || j < 0 || j >= order.length) return;
        const next = [...order];
        next[i] = order[j]!;
        next[j] = id;
        commit(next);
    };
    return (
        <Section title={t("set.navigation")} sub={t("set.navigationSub")} testId="set-navigation">
            {order.map((id, i) => (
                <div key={id} className="set-navrow" data-focus-row={`set-nav-${id}`}>
                    <Row focusKey={`set:nav:${id}`} icon={NAV_ICON[id]} label={t(`set.nav.${id}`)}
                        value={id === "settings" ? t("set.navAlways") : t("set.navShown")}
                        onClick={() => { if (id !== "settings") commit(order.filter((x) => x !== id)); }} />
                    <IconButton icon="chevronLeft" label={t("set.moveUp")} focusKey={`set:nav:${id}:up`} onClick={() => move(id, -1)} disabled={i === 0} className="set-rot-up" />
                    <IconButton icon="chevronLeft" label={t("set.moveDown")} focusKey={`set:nav:${id}:down`} onClick={() => move(id, 1)} disabled={i === order.length - 1} className="set-rot-down" />
                </div>
            ))}
            {hidden.length > 0 && <h3 className="set-h3">{t("set.navHidden")}</h3>}
            {hidden.map((id) => (
                <Row key={id} focusKey={`set:nav:${id}`} icon={NAV_ICON[id]} label={t(`set.nav.${id}`)} value={t("set.navShow")}
                    onClick={() => commit([...order.filter((x) => x !== "settings"), id, "settings"])} />
            ))}
            <div className="set-actions">
                <SecondaryButton icon="refresh" label={t("set.navReset")} onClick={() => commit([...NAV_IDS])} focusKey="set:nav:reset" />
            </div>
        </Section>
    );
}

export function ScreenSection() {
    const [fmt, setFmt, k] = useScreenFormat();
    const items: Array<{ id: ScreenFormatKey; label: string }> = [
        { id: "auto", label: t("pl.auto") }, { id: "16:9", label: "16:9" }, { id: "21:9", label: "21:9" }, { id: "32:9", label: "32:9" },
    ];
    return (
        <Section title={t("set.screen")} sub={t("set.screenSub")} testId="set-screen">
            <ChipRow label={t("pl.format")} rowId="set-format" value={fmt} items={items} onChange={(id) => setFmt(id as ScreenFormatKey)} />
            <Note>{t("set.screenNow", { w: window.innerWidth, h: window.innerHeight, k: k === 1 ? "1" : k.toFixed(3) })}</Note>
        </Section>
    );
}

// ─── server / account / cache ──────────────────────────────────────────────

function useHealth(baseUrl: string): { version: string | null; ok: boolean | null } {
    const [s, set] = useState<{ version: string | null; ok: boolean | null }>({ version: null, ok: null });
    useEffect(() => {
        let alive = true;
        fetch(`${baseUrl}/health`).then((r) => r.json() as Promise<{ version?: string }>)
            .then((j) => { if (alive) set({ version: j.version ?? null, ok: true }); })
            .catch(() => { if (alive) set({ version: null, ok: false }); });
        return () => { alive = false; };
    }, [baseUrl]);
    return s;
}

export function ServerSection({ ctx }: { ctx: ScreenCtx }) {
    const h = useHealth(ctx.cfg.baseUrl);
    const [confirm, setConfirm] = useState(false);
    return (
        <Section title={t("set.server")} testId="set-server">
            <Row focusKey="set:srv:url" icon="server" label={t("set.serverUrl")} value={ctx.cfg.baseUrl} />
            <Row focusKey="set:srv:ver" icon="info" label={t("set.serverVersion")}
                value={h.ok === null ? t("common.loading") : h.ok ? (h.version ?? "?") : t("set.unreachable")} />
            <Row focusKey="set:srv:change" icon="refresh" chevron label={t("set.changeServer")} sub={t("set.changeServerSub")} onClick={() => setConfirm(true)} testId="set-change-server" />
            <Dialog open={confirm} icon="server" title={t("set.changeServer")} message={t("set.changeServerMsg")} confirmLabel={t("set.changeServerOk")}
                onConfirm={() => { setConfirm(false); ctx.app.disconnect(); }} onCancel={() => setConfirm(false)} />
        </Section>
    );
}

export function AccountSection({ ctx }: { ctx: ScreenCtx }) {
    const [confirm, setConfirm] = useState(false);
    const s = ctx.app.session;
    const signOut = ctx.app.signOut;
    return (
        <Section title={t("set.account")} testId="set-account">
            {s ? (
                <>
                    <Row focusKey="set:acc:user" icon="user" label={s.user.name ?? t("set.signedIn")} sub={t("set.sessionUntil", { date: new Date(s.expires).toLocaleDateString(ctx.lang === "ro" ? "ro-RO" : "en-GB") })} />
                    <Row focusKey="set:acc:out" icon="close" destructive label={t("set.signOut")} onClick={() => setConfirm(true)} testId="set-sign-out" />
                </>
            ) : (
                <Note>{t("set.localOnly")}</Note>
            )}
            <Dialog open={confirm && !!signOut} destructive icon="alert" title={t("set.signOut")} message={t("set.signOutMsg")} confirmLabel={t("set.signOut")}
                onConfirm={() => { setConfirm(false); signOut?.(); }} onCancel={() => setConfirm(false)} />
        </Section>
    );
}

function clearHomeCaches(): number {
    let n = 0;
    try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(HOME_CACHE_PREFIX)) keys.push(k); }
        for (const k of keys) { localStorage.removeItem(k); n++; }
    } catch { /* storage disabled */ }
    clearLoaded();
    return n;
}

export function CacheSection({ ctx }: { ctx: ScreenCtx }) {
    const [msg, setMsg] = useState<string | null>(null);
    const [confirm, setConfirm] = useState(false);
    return (
        <Section title={t("set.cache")} sub={t("set.cacheSub")} testId="set-cache">
            <Row focusKey="set:cache:home" icon="refresh" label={t("set.clearHome")} sub={t("set.clearHomeSub")} testId="set-clear-home"
                onClick={() => { const n = clearHomeCaches(); ctx.media.invalidate(); setMsg(t("set.cleared", { n })); }} />
            <Row focusKey="set:cache:progress" icon="close" destructive label={t("set.clearProgress")} sub={t("set.clearProgressSub")} onClick={() => setConfirm(true)} />
            {msg && <Note tone="success">{msg}</Note>}
            <Dialog open={confirm} destructive icon="alert" title={t("set.clearProgress")} message={t("set.clearProgressMsg")} confirmLabel={t("set.clear")}
                onConfirm={() => { clearProgress(); setConfirm(false); setMsg(t("set.progressCleared")); }} onCancel={() => setConfirm(false)} />
        </Section>
    );
}

// ─── Watch Together device name ────────────────────────────────────────────

function NameEditor({ initial, onDone, onCancel }: { initial: string; onDone: (v: string) => void; onCancel: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [v, setV] = useState(initial);
    useFocusScope(ref, true);
    useBackHandler(() => { onCancel(); }, true);
    return (
        <div className="overlay" role="presentation">
            <div ref={ref} className="dialog tg-join" role="dialog" aria-modal="true" aria-labelledby="set-dn-title" data-focus-scope="">
                <h2 id="set-dn-title" className="dialog-title">{t("set.deviceName")}</h2>
                <div className="tg-code" aria-live="polite">{v || <span className="tg-dim">{readDeviceName()}</span>}</div>
                <Keyboard value={v} onChange={setV} onDone={() => onDone(v)} maxLength={40} id="set-dn" />
                <div className="dialog-actions" data-focus-row="set-dn-actions">
                    <SecondaryButton label={t("common.cancel")} onClick={onCancel} focusKey="set:dn:cancel" />
                    <PrimaryButton label={t("set.save")} onClick={() => onDone(v)} focusKey="set:dn:ok" />
                </div>
            </div>
        </div>
    );
}

export function TogetherSection({ ctx }: { ctx: ScreenCtx }) {
    const [name, setName] = useState(customDeviceName());
    const [editing, setEditing] = useState(false);
    return (
        <Section title={t("set.together")} sub={t("set.togetherSub")} testId="set-together">
            <Row focusKey="set:tg:name" icon="tv" chevron label={t("set.deviceName")} value={name || readDeviceName()} onClick={() => setEditing(true)} />
            <Row focusKey="set:tg:open" icon="group" chevron label={t("set.openTogether")} onClick={() => ctx.nav.push({ name: "together" })} />
            {editing && <NameEditor initial={name} onCancel={() => setEditing(false)} onDone={(v) => { writeDeviceName(v); setName(v.trim()); setEditing(false); }} />}
        </Section>
    );
}

// ─── About / diagnostics ───────────────────────────────────────────────────

export function AboutSection({ ctx }: { ctx: ScreenCtx }) {
    const h = useHealth(ctx.cfg.baseUrl);
    const [hub, setHub] = useState<HubStatus>(ctx.hub.status);
    const [status, setStatus] = useState<MediaStatus | null | undefined>(undefined);
    useEffect(() => { setHub(ctx.hub.status); return ctx.hub.statusChanged.on(setHub); }, [ctx.hub]);
    useEffect(() => {
        let alive = true;
        ctx.media.mediaStatus().then((s) => { if (alive) setStatus(s); }).catch(() => { if (alive) setStatus(null); });
        return () => { alive = false; };
    }, [ctx.media]);
    const k = squeezeFactor();
    const rows: Array<[string, string]> = [
        [t("set.appVersion"), APP_VERSION],
        [t("set.serverVersion"), h.ok === null ? "…" : h.version ?? t("set.unreachable")],
        [t("set.hubStatus"), t(`tg.status.${hub}`)],
        [t("set.viewport"), `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio || 1}x`],
        [t("set.squeeze"), k === 1 ? "1" : k.toFixed(3)],
        [t("set.tmdb"), status === undefined ? "…" : status?.tmdb ? t("set.yes") : t("set.no")],
        [t("set.library"), status ? String(status.libraryCount) : "—"],
        [t("set.profile"), ctx.profiles.active?.name ?? ctx.profiles.profileId],
        [t("set.userAgent"), navigator.userAgent],
    ];
    return (
        <Section title={t("set.about")} testId="set-about">
            <dl className="set-about" data-focusable="" tabIndex={-1} data-focus-key="set:about">
                {rows.map(([a, b]) => <div key={a} className="set-kv"><dt>{a}</dt><dd>{b}</dd></div>)}
            </dl>
            <div className="set-actions"><Icon name="info" /> <span className="tg-dim tg-small">{t("set.aboutHint")}</span></div>
        </Section>
    );
}
