/**
 * MixAI TV (Tizen) shell — WP16-30.
 *   App            re-keys the tree on a language change.
 *   AppRoot        connection state (config/session), data clients, hub lifecycle, boot flow:
 *                  no config → Welcome; config → health + profiles.restore() → Profiles (picker) or Home.
 *   Shell          inside <NavProvider>: rail + keep-alive <Outlet>, global D-pad/Back handling (focus v2),
 *                  exit-confirm dialog, hub remote commands, e2e hook commands (`open:`, `play:`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    loadConfig, saveConfig, clearConfig, loadSession, saveSession, clearSession,
    type ServerConfig, type Session,
} from "./lib/config";
import { APP_VERSION, type Companion } from "./lib/device-auth";
import { MmoClient } from "./lib/api";
import { MediaClient } from "./lib/media";
import { MusicClient } from "./lib/music";
import { LiveTvClient } from "./lib/livetv";
import { ProfilesClient } from "./lib/profiles";
import { HubClient, type HubCommand } from "./lib/hub";
import { playerBus, type PlayerCommand } from "./lib/player-bus";
import { flushQueue, migrateLocalProgress } from "./lib/progress-sync";
import type { MediaKind } from "./lib/media-types";
import { keyFromEvent, registerTvKeys, exitApp, type TvKey } from "./lib/tv-keys";
import { installE2ePressHook, setE2eCommandHandler } from "./lib/e2e-press";
import { moveFocus, currentFocus, installRowMemory, installPointer, focusRail, isInRail } from "./lib/focus";
import { hasPointer } from "./platform";
import type { DiscoveredServer } from "./lib/discovery";
import { useLocale } from "./i18n/useLocale";
import { t, type Locale } from "./i18n/messages";
import { NavProvider, Outlet, useNav, useScreenActive, type NavApi } from "./nav/Nav";
import { consumeBack } from "./nav/back";
import { Rail } from "./nav/Rail";
import { hasRail, TOP_LEVEL, type Route } from "./nav/routes";
import type { AppActions, ScreenCtx } from "./nav/ctx";
import { BackdropProvider, Dialog, IconSprite, LoadingBlock } from "./ui";
import { WelcomeScreen } from "./screens/Welcome";
import { SignInScreen } from "./screens/SignIn";
import { ConnectScreen } from "./screens/Connect";
import { DiscoverScreen } from "./screens/Discover";
import { PairScreen } from "./screens/Pair";
import { ShowScreen } from "./screens/Show";
import { PlayerScreen } from "./screens/Player";
import { musicPlayer, trackLookup } from "./lib/music-player";
import { parseMusicPlayArgs, isMusicPlay } from "./lib/music-remote";
import { Profiles } from "./screens/Profiles";
import { Home } from "./screens/Home";
import { Title } from "./screens/Title";
import { Season } from "./screens/Season";
import { Library } from "./screens/Library";
import { Search } from "./screens/Search";
import { Settings } from "./screens/Settings";
import { Stats } from "./screens/Stats";
import { Music } from "./screens/Music";
import { Artist } from "./screens/Artist";
import { MusicAlbum } from "./screens/MusicAlbum";
import { NowPlaying } from "./screens/NowPlaying";
import { LiveTv } from "./screens/LiveTv";
import { Guide } from "./screens/Guide";
import { Recordings } from "./screens/Recordings";
import { LivePlay } from "./screens/LivePlay";
import { Together } from "./screens/Together";

function toDiscovered(cfg: ServerConfig): DiscoveredServer {
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?/i.exec(cfg.baseUrl);
    return { baseUrl: cfg.baseUrl, host: m?.[1] ?? cfg.baseUrl, port: m?.[2] ? Number(m[2]) : 17899, info: null };
}

/** `navigate {to}` paths from the hub / web remote: "home", "movies", "title/movie/550", "season/1399/2", … */
export function routeFromPath(to: string): Route | null {
    const [a = "", b, c] = to.replace(/^\/+/, "").split("/");
    switch (a) {
        case "home": case "music": case "livetv": case "guide": case "recordings": case "nowPlaying": return { name: a } as Route;
        case "search": return b ? { name: "search", initial: decodeURIComponent(b) } : { name: "search" };
        case "settings": return b ? { name: "settings", section: b } : { name: "settings" };
        case "movies": return { name: "library", kind: "movie" };
        case "shows": case "tv": return { name: "library", kind: "tv" };
        case "profiles": return { name: "profiles", manage: true };
        case "stats": return b ? { name: "stats", year: Number(b) } : { name: "stats" };
        case "together": return b ? { name: "together", roomId: b } : { name: "together" };
        case "title": return (b === "movie" || b === "tv") && c ? { name: "title", kind: b, tmdbId: Number(c) } : null;
        case "season": return b && c ? { name: "season", tmdbId: Number(b), season: Number(c) } : null;
        case "artist": return b ? { name: "artist", id: b } : null;
        case "album": return b ? { name: "album", id: b } : null;
        case "channel": case "livePlay": return b ? { name: "livePlay", channelId: b } : null;
        default: return null;
    }
}

export function App() {
    const [locale] = useLocale();
    // Re-key the whole tree on a language change so every `t()` re-evaluates.
    return <AppRoot key={locale} lang={locale} />;
}

interface Clients {
    client: MmoClient;
    profiles: ProfilesClient;
    media: MediaClient;
    music: MusicClient;
    livetv: LiveTvClient;
    hub: HubClient;
}

function makeClients(cfg: ServerConfig): Clients {
    const client = new MmoClient(cfg);
    const profiles = new ProfilesClient(cfg);
    return {
        client,
        profiles,
        media: new MediaClient(cfg, client, profiles),
        music: new MusicClient(cfg, profiles),
        livetv: new LiveTvClient(cfg, profiles),
        hub: new HubClient(cfg, () => profiles.profileId, APP_VERSION),
    };
}

function AppRoot({ lang }: { lang: Locale }) {
    const [cfg, setCfg] = useState<ServerConfig | null>(() => loadConfig());
    const [session, setSession] = useState<Session | null>(() => loadSession());
    /** Root route + generation; `null` while booting a configured server. Bumping `n` remounts the stack. */
    const [start, setStart] = useState<{ n: number; route: Route } | null>(() => (loadConfig() ? null : { n: 0, route: { name: "welcome" } }));
    const clients = useMemo(() => (cfg ? makeClients(cfg) : null), [cfg]);

    const restart = useCallback((route: Route) => setStart((s) => ({ n: (s?.n ?? 0) + 1, route })), []);

    useEffect(() => { registerTvKeys(); installRowMemory(); if (hasPointer()) installPointer(); installE2ePressHook(); }, []);

    // Hub: one socket per server config.
    useEffect(() => {
        if (!clients) return;
        clients.hub.start();
        return () => clients.hub.stop();
    }, [clients]);
    // Background music engine: restore the server queue + receive remote commands before Music is opened.
    useEffect(() => { if (clients) musicPlayer.attach(clients.music, clients.media); }, [clients]);

    // Boot: reachable? → profiles → picker or Home.
    useEffect(() => {
        if (!cfg || !clients || start !== null) return;
        let alive = true;
        void (async () => {
            const ok = await MmoClient.health(cfg.baseUrl);
            if (!alive) return;
            if (!ok) { restart({ name: "discover", preselected: toDiscovered(cfg) }); return; }
            await clients.profiles.restore();
            if (!alive) return;
            const picker = clients.profiles.needsPicker();
            if (!picker) warmUp(clients);
            restart(picker ? { name: "profiles" } : { name: "home" });
        })();
        return () => { alive = false; };
    }, [cfg, clients, start, restart]);

    const onConnected = useCallback((c: ServerConfig) => {
        saveConfig(c);
        setCfg(c);
        setStart(null);
    }, []);

    const disconnect = useCallback(() => {
        clearConfig();
        setCfg(null);
        restart({ name: "discover", preselected: null });
    }, [restart]);

    const signOut = useCallback(() => {
        clearConfig();
        clearSession();
        setCfg(null);
        setSession(null);
        restart({ name: "welcome" });
    }, [restart]);

    const onSignedIn = useCallback((s: Session, picked: { companion: Companion; baseUrl: string } | null) => {
        saveSession(s);
        setSession(s);
        if (picked) onConnected({ baseUrl: picked.baseUrl, token: picked.companion.token, userId: s.user.id });
        else restart({ name: "discover", preselected: null });
    }, [onConnected, restart]);

    const profileChanged = useCallback(() => {
        if (!clients) return;
        clients.media.invalidate();
        clients.hub.refreshHello();
        warmUp(clients);
        restart({ name: "home" });
    }, [clients, restart]);

    const app = useMemo<AppActions>(() => ({
        disconnect, signOut: session ? signOut : null, session, profileChanged,
    }), [disconnect, signOut, session, profileChanged]);

    const onboarding: Onboarding = useMemo(() => ({ cfg, onConnected, onSignedIn }), [cfg, onConnected, onSignedIn]);

    return (
        <BackdropProvider>
            <IconSprite />
            {start === null ? (
                <div className="profiles" data-testid="boot">
                    <h1 className="profiles-title">{t("home.title")}</h1>
                    <div style={{ width: "30rem" }}><LoadingBlock lines={2} /></div>
                </div>
            ) : (
                <NavProvider key={start.n} initial={start.route}>
                    <Shell clients={clients} cfg={cfg} lang={lang} app={app} onboarding={onboarding} />
                </NavProvider>
            )}
        </BackdropProvider>
    );
}

/** Background work once a profile is active: retry queued progress, one-shot migration, warm Home cache. */
function warmUp(c: Clients): void {
    void flushQueue(c.media).then(() => migrateLocalProgress(c.media)).catch(() => undefined);
    void c.media.revalidateHome().catch(() => undefined);
}

interface Onboarding {
    cfg: ServerConfig | null;
    onConnected: (c: ServerConfig) => void;
    onSignedIn: (s: Session, picked: { companion: Companion; baseUrl: string } | null) => void;
}

function Shell({ clients, cfg, lang, app, onboarding }: {
    clients: Clients | null; cfg: ServerConfig | null; lang: Locale; app: AppActions; onboarding: Onboarding;
}) {
    const nav = useNav();
    const [exitOpen, setExitOpen] = useState(false);
    const [profile, setProfile] = useState(() => clients?.profiles.active ?? null);
    const current = nav.current;
    const rail = hasRail(current) && !!clients;

    useEffect(() => {
        if (!clients) return;
        setProfile(clients.profiles.active);
        return clients.profiles.changed.on((p) => setProfile(p));
    }, [clients]);

    const ctx = useMemo<ScreenCtx | null>(() => (clients && cfg ? {
        client: clients.client, media: clients.media, profiles: clients.profiles, music: clients.music,
        livetv: clients.livetv, hub: clients.hub, cfg, nav, lang, app,
    } : null), [clients, cfg, nav, lang, app]);

    // ─── Back ────────────────────────────────────────────────────────────
    const handleBack = useCallback(() => {
        if (consumeBack()) return;
        const cur = nav.current;
        if (TOP_LEVEL.has(cur.name) && !nav.canPop) {
            if (!isInRail() && focusRail()) return;
            setExitOpen(true);
            return;
        }
        if (nav.pop()) return;
        switch (cur.name) {
            case "signin": case "discover": case "connect": case "pair":
                if (!onboarding.cfg) { nav.resetTo({ name: "welcome" }); return; }
                if (clients) { nav.resetTo({ name: "home" }); return; }
                setExitOpen(true); return;
            default:
                setExitOpen(true);
        }
    }, [nav, onboarding.cfg, clients]);

    // ─── Global D-pad (the Player owns its keys in the capture phase) ────
    const backRef = useRef(handleBack);
    backRef.current = handleBack;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k: TvKey = keyFromEvent(e);
            const target = e.target as HTMLElement | null;
            const inInput = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
            switch (k) {
                case "up": case "down": case "left": case "right":
                    if (inInput && (k === "left" || k === "right")) return;
                    e.preventDefault();
                    moveFocus(k);
                    return;
                case "enter":
                    if (inInput) return;
                    currentFocus()?.click();
                    e.preventDefault();
                    return;
                case "back":
                    if (inInput && e.keyCode === 8) return; // Backspace edits text
                    e.preventDefault();
                    backRef.current();
                    return;
                default:
                    return;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // ─── Hub remote commands ─────────────────────────────────────────────
    const openRoute = useCallback((r: Route) => {
        if (TOP_LEVEL.has(r.name) && r.name !== "search") nav.resetTo(r); else nav.push(r);
    }, [nav]);

    const playFile = useCallback(async (fileId: string, startSec: number, ref?: { kind: MediaKind; tmdbId: number; season?: number; episode?: number }) => {
        if (!clients) throw new Error("not_connected");
        const video = await clients.client.resolveVideo(fileId, "");
        nav.push({ name: "player", item: { kind: "video", video, ref, resumeSec: startSec > 0 ? startSec : undefined } });
    }, [clients, nav]);

    useEffect(() => {
        if (!clients) return;
        const hub = clients.hub;
        return hub.commands.on((cmd: HubCommand) => { void handleHubCommand(cmd); });

        async function handleHubCommand(cmd: HubCommand): Promise<void> {
            const a = cmd.args;
            const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
            const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
            try {
                switch (cmd.action) {
                    case "play": {
                        if (isMusicPlay(a)) { await playMusic(cmd); return; }
                        const fileId = str(a.fileId);
                        if (!fileId) { hub.ack(cmd.seq, false, "fileId_required"); return; }
                        const kind = a.kind === "tv" || a.kind === "movie" ? (a.kind as MediaKind) : undefined;
                        const tmdbId = num(a.tmdbId);
                        const ref = kind && tmdbId ? { kind, tmdbId, season: num(a.season), episode: num(a.episode) } : undefined;
                        await playFile(fileId, num(a.startSec) ?? 0, ref);
                        hub.ack(cmd.seq, true);
                        return;
                    }
                    case "pause": case "resume": case "stop": case "next": case "previous": case "seek": case "volume": {
                        const pc: PlayerCommand | null =
                            cmd.action === "seek" ? (num(a.positionSec) !== undefined ? { type: "seek", positionSec: num(a.positionSec)! } : null)
                            : cmd.action === "volume" ? (num(a.level) !== undefined ? { type: "volume", level: num(a.level)! } : null)
                            : { type: cmd.action } as PlayerCommand;
                        if (!pc) { hub.ack(cmd.seq, false, "bad_args"); return; }
                        // Video/live player first (top bus handler), else the background music engine.
                        let ok = playerBus.send(pc);
                        if (!ok && musicPlayer.hasTrack) ok = musicPlayer.remote(pc);
                        hub.ack(cmd.seq, ok, ok ? undefined : "no_player");
                        return;
                    }
                    case "text": {
                        const v = str(a.value) ?? "";
                        nav.push({ name: "search", initial: v });
                        hub.ack(cmd.seq, true);
                        return;
                    }
                    case "navigate": {
                        const r = routeFromPath(str(a.to) ?? "");
                        if (!r) { hub.ack(cmd.seq, false, "bad_route"); return; }
                        openRoute(r);
                        hub.ack(cmd.seq, true);
                        return;
                    }
                    default:
                        hub.ack(cmd.seq, false, "unsupported");
                }
            } catch (e) {
                hub.ack(cmd.seq, false, (e as Error).message || "error");
            }
        }

        /** `play {trackIds, index, positionSec?, shuffle?, repeat?}` → replace the music queue (server 3.12). */
        async function playMusic(cmd: HubCommand): Promise<void> {
            if (!clients || !cfg) { hub.ack(cmd.seq, false, "not_connected"); return; }
            const p = parseMusicPlayArgs(cmd.args);
            if (!p) { hub.ack(cmd.seq, false, "trackIds_required"); return; }
            // A video/live player on top would pause the music on its next now-playing publish → close it.
            const np = playerBus.nowPlaying();
            if (np && np.kind !== "audio") playerBus.send({ type: "stop" });
            musicPlayer.attach(clients.music, clients.media);
            const n = await musicPlayer.playIds(p.trackIds, p.index, { shuffle: p.shuffle, startSec: p.positionSec, repeat: p.repeat },
                trackLookup(cfg, () => clients.profiles.headers()));
            if (n === 0) { hub.ack(cmd.seq, false, "tracks_not_found"); return; }
            if (nav.current.name !== "nowPlaying") openRoute({ name: "nowPlaying" });
            hub.ack(cmd.seq, true);
        }
    }, [clients, cfg, nav, playFile, openRoute]);

    // ─── e2e driver (debug builds only): `open:<kind>:<tmdbId>`, `play:<fileId>:<sec>` ──
    useEffect(() => {
        setE2eCommandHandler((cmd) => {
            const m = /^open:(movie|tv):(\d+)$/.exec(cmd);
            if (m) nav.push({ name: "title", kind: m[1] as MediaKind, tmdbId: Number(m[2]) });
            const p = /^play:([A-Za-z0-9_-]+):(\d+)$/.exec(cmd);
            if (p) void playFile(p[1]!, Number(p[2])).catch(() => undefined);
            const n = /^nav:(.+)$/.exec(cmd);
            if (n) { const r = routeFromPath(n[1]!); if (r) openRoute(r); }
        });
        return () => setE2eCommandHandler(null);
    }, [nav, playFile, openRoute]);

    // ─── Route → screen ──────────────────────────────────────────────────
    const render = useCallback((r: Route) => renderRoute(r, ctx, nav, onboarding), [ctx, nav, onboarding]);

    return (
        <div className={`app-shell${rail ? " with-rail" : ""}`} data-route={current.name}>
            {rail && <Rail profile={profile} onProfile={() => nav.push({ name: "profiles", manage: true })} />}
            <main className="app-content">
                <Outlet render={render} />
            </main>
            <Dialog
                open={exitOpen}
                title={t("exit.title")}
                message={t("exit.message")}
                icon="close"
                confirmLabel={t("exit.confirm")}
                cancelLabel={t("exit.cancel")}
                onConfirm={() => { setExitOpen(false); exitApp(); }}
                onCancel={() => setExitOpen(false)}
                testId="exit-dialog"
            />
        </div>
    );
}

function PlayerRoute({ ctx, r, nav }: { ctx: ScreenCtx; r: Extract<Route, { name: "player" }>; nav: NavApi }) {
    const active = useScreenActive();
    return (
        <PlayerScreen client={ctx.client} media={ctx.media} item={r.item} queue={r.queue} index={r.index} active={active} ctx={ctx}
            onExit={() => { if (!nav.pop()) nav.resetTo({ name: "home" }); }} />
    );
}

function renderRoute(r: Route, ctx: ScreenCtx | null, nav: NavApi, ob: Onboarding) {
    const discover = (preselected: DiscoveredServer | null) => (
        <DiscoverScreen preselected={preselected} onSelect={(server) => nav.push({ name: "pair", server })} onManual={() => nav.push({ name: "connect" })} />
    );
    switch (r.name) {
        case "welcome":
            return <WelcomeScreen onSignIn={() => nav.push({ name: "signin" })} onLocal={() => nav.push({ name: "discover", preselected: null })} />;
        case "signin":
            return <SignInScreen onSignedIn={ob.onSignedIn} onBack={() => { if (!nav.pop()) nav.resetTo({ name: "welcome" }); }} />;
        case "discover":
            return discover(r.preselected);
        case "pair":
            return <PairScreen server={r.server} onPaired={ob.onConnected} onBack={() => { if (!nav.pop()) nav.resetTo({ name: "discover", preselected: null }); }} />;
        case "connect":
            return <ConnectScreen initial={ob.cfg} onConnected={ob.onConnected} onQuickConnect={(server) => nav.push({ name: "pair", server })} />;
        default:
            break;
    }
    if (!ctx) return discover(null);
    switch (r.name) {
        case "profiles": return <Profiles ctx={ctx} params={r} />;
        case "home": return <Home ctx={ctx} params={r} />;
        case "search": return <Search ctx={ctx} params={r} />;
        case "library": return <Library ctx={ctx} params={r} />;
        case "music": return <Music ctx={ctx} params={r} />;
        case "livetv": return <LiveTv ctx={ctx} params={r} />;
        case "settings": return <Settings ctx={ctx} params={r} />;
        case "title": return <Title ctx={ctx} params={r} />;
        case "season": return <Season ctx={ctx} params={r} />;
        case "show": return <ShowScreen client={ctx.client} show={r.show} onPlay={(video) => {
            // Library-built shows carry no probe data (container/duration null) → resolve first.
            if (video.container != null || video.durationSec != null) { nav.push({ name: "player", item: { kind: "video", video } }); return; }
            void ctx.client.resolveVideo(video.fileId, video.path)
                .then((v) => nav.push({ name: "player", item: { kind: "video", video: v } }))
                .catch(() => nav.push({ name: "player", item: { kind: "video", video } }));
        }} />;
        case "artist": return <Artist ctx={ctx} params={r} />;
        case "album": return <MusicAlbum ctx={ctx} params={r} />;
        case "guide": return <Guide ctx={ctx} params={r} />;
        case "recordings": return <Recordings ctx={ctx} params={r} />;
        case "stats": return <Stats ctx={ctx} params={r} />;
        case "together": return <Together ctx={ctx} params={r} />;
        case "nowPlaying": return <NowPlaying ctx={ctx} params={r} />;
        case "livePlay": return <LivePlay ctx={ctx} params={r} />;
        case "player": return <PlayerRoute ctx={ctx} r={r} nav={nav} />;
    }
}
