import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    loadConfig, saveConfig, clearConfig, loadSession, saveSession, clearSession,
    type ServerConfig, type Session,
} from "./lib/config";
import type { Companion } from "./lib/device-auth";
import { MmoClient, type ProbedVideo, type SubsonicAlbum, type SubsonicSong } from "./lib/api";
import { MediaClient } from "./lib/media";
import type { MediaKind, TitleCard } from "./lib/media-types";
import { keyFromEvent, registerTvKeys, exitApp, type TvKey } from "./lib/tv-keys";
import { installE2ePressHook, setE2eCommandHandler } from "./lib/e2e-press";
import { moveFocus, currentFocus, installRowMemory } from "./lib/focus";
import type { DiscoveredServer } from "./lib/discovery";
import type { Show } from "./lib/shows";
import { useLocale } from "./i18n/useLocale";
import { WelcomeScreen } from "./screens/Welcome";
import { SignInScreen } from "./screens/SignIn";
import { ConnectScreen } from "./screens/Connect";
import { DiscoverScreen } from "./screens/Discover";
import { PairScreen } from "./screens/Pair";
import { HomeScreen } from "./screens/Home";
import { AlbumScreen } from "./screens/Album";
import { ShowScreen } from "./screens/Show";
import { SearchScreen } from "./screens/Search";
import { TitleScreen, type PlayRequest } from "./screens/Title";
import { PlayerScreen, type PlayItem } from "./screens/Player";

type Route =
    | { name: "welcome" }
    | { name: "signin" }
    | { name: "discover"; preselected: DiscoveredServer | null }
    | { name: "pair"; server: DiscoveredServer }
    | { name: "connect" }
    | { name: "home" }
    | { name: "album"; album: SubsonicAlbum }
    | { name: "show"; show: Show }
    | { name: "search"; videos: ProbedVideo[] }
    | { name: "title"; kind: MediaKind; tmdbId: number; seed?: TitleCard }
    | { name: "player"; item: PlayItem; queue?: PlayItem[]; index?: number };

function toDiscovered(cfg: ServerConfig): DiscoveredServer {
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?/i.exec(cfg.baseUrl);
    return { baseUrl: cfg.baseUrl, host: m?.[1] ?? cfg.baseUrl, port: m?.[2] ? Number(m[2]) : 17899, info: null };
}

export function App() {
    const [locale] = useLocale();
    // Re-key the whole tree on a language change so every `t()` re-evaluates.
    return <AppRoutes key={locale} />;
}

function AppRoutes() {
    const [cfg, setCfg] = useState<ServerConfig | null>(() => loadConfig());
    const [session, setSession] = useState<Session | null>(() => loadSession());
    const [route, setRoute] = useState<Route>(() => (loadConfig() ? { name: "home" } : { name: "welcome" }));
    const stack = useRef<Route[]>([]);
    const client = useMemo(() => (cfg ? new MmoClient(cfg) : null), [cfg]);
    const media = useMemo(() => (cfg && client ? new MediaClient(cfg, client) : null), [cfg, client]);

    // Saved server → Home directly; if it is not reachable, fall back to
    // discovery with the saved one preselected (mirrors tv-android).
    useEffect(() => {
        if (!cfg || route.name !== "home") return;
        let alive = true;
        void MmoClient.health(cfg.baseUrl).then((ok) => {
            if (alive && !ok) { stack.current = []; setRoute({ name: "discover", preselected: toDiscovered(cfg) }); }
        });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cfg]);

    const push = useCallback((r: Route) => {
        setRoute((cur) => { stack.current.push(cur); return r; });
    }, []);
    const pop = useCallback((): boolean => {
        const prev = stack.current.pop();
        if (!prev) return false;
        setRoute(prev);
        return true;
    }, []);

    useEffect(() => { registerTvKeys(); installRowMemory(); installE2ePressHook(); }, []);

    // Global D-pad handling. The Player owns its keys and stops propagation.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k: TvKey = keyFromEvent(e);
            const target = e.target as HTMLElement | null;
            const inInput = !!target && target.tagName === "INPUT";
            switch (k) {
                case "up": case "down": case "left": case "right":
                    // Let the text caret move inside inputs for left/right.
                    if (inInput && (k === "left" || k === "right")) return;
                    e.preventDefault();
                    moveFocus(k);
                    return;
                case "enter":
                    if (inInput) return; // form submit handles it
                    currentFocus()?.click();
                    e.preventDefault();
                    return;
                case "back":
                    if (inInput && k === "back" && e.keyCode === 8) return; // Backspace edits text
                    e.preventDefault();
                    if (!pop()) {
                        if (route.name === "home" || route.name === "welcome") exitApp();
                        else if (route.name === "discover" || route.name === "signin") setRoute({ name: "welcome" });
                    }
                    return;
                default:
                    return;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [pop, route.name]);

    const onConnected = (c: ServerConfig) => {
        saveConfig(c);
        setCfg(c);
        stack.current = [];
        setRoute({ name: "home" });
    };

    const onDisconnect = () => {
        clearConfig();
        setCfg(null);
        stack.current = [];
        setRoute({ name: "discover", preselected: null });
    };

    const onSignOut = () => {
        clearConfig();
        clearSession();
        setCfg(null);
        setSession(null);
        stack.current = [];
        setRoute({ name: "welcome" });
    };

    const onSignedIn = useCallback((s: Session, picked: { companion: Companion; baseUrl: string } | null) => {
        saveSession(s);
        setSession(s);
        stack.current = [];
        if (picked) {
            const c: ServerConfig = { baseUrl: picked.baseUrl, token: picked.companion.token, userId: s.user.id };
            saveConfig(c);
            setCfg(c);
            setRoute({ name: "home" });
        } else {
            setRoute({ name: "discover", preselected: null });
        }
    }, []);

    const playVideo = (v: ProbedVideo) => {
        push({ name: "player", item: { kind: "video", video: v } });
    };
    const playFromTitle = (r: PlayRequest) => {
        push({ name: "player", item: { kind: "video", video: r.video, ref: r.ref, resumeSec: r.resumeSec } });
    };
    const openTitle = (c: TitleCard) => push({ name: "title", kind: c.kind, tmdbId: c.tmdbId, seed: c });
    // Debug-only (no-op in production): `open:<kind>:<tmdbId>` from the e2e driver.
    useEffect(() => {
        setE2eCommandHandler((cmd) => {
            const m = /^open:(movie|tv):(\d+)$/.exec(cmd);
            if (m) push({ name: "title", kind: m[1] as MediaKind, tmdbId: Number(m[2]) });
        });
        return () => setE2eCommandHandler(null);
    }, [push]);

    const playAlbum = (album: SubsonicAlbum, songs: SubsonicSong[], index: number) => {
        const queue: PlayItem[] = songs.map((s) => ({ kind: "audio", song: s, album }));
        push({ name: "player", item: queue[index] ?? queue[0]!, queue, index });
    };

    switch (route.name) {
        case "welcome":
            return <WelcomeScreen onSignIn={() => push({ name: "signin" })} onLocal={() => push({ name: "discover", preselected: null })} />;
        case "signin":
            return <SignInScreen onSignedIn={onSignedIn} onBack={() => { if (!pop()) setRoute({ name: "welcome" }); }} />;
        case "discover":
            return (
                <DiscoverScreen
                    preselected={route.preselected}
                    onSelect={(server) => push({ name: "pair", server })}
                    onManual={() => push({ name: "connect" })}
                />
            );
        case "pair":
            return <PairScreen server={route.server} onPaired={onConnected} onBack={() => { if (!pop()) setRoute({ name: "discover", preselected: null }); }} />;
        case "connect":
            return <ConnectScreen initial={cfg} onConnected={onConnected} onQuickConnect={(server) => push({ name: "pair", server })} />;
        case "home":
            if (!client) return <DiscoverScreen preselected={null} onSelect={(server) => push({ name: "pair", server })} onManual={() => push({ name: "connect" })} />;
            return (
                <HomeScreen
                    client={client}
                    media={media!}
                    cfg={cfg!}
                    user={session?.user ?? null}
                    onPlayVideo={playVideo}
                    onOpenTitle={openTitle}
                    onOpenShow={(show) => push({ name: "show", show })}
                    onOpenAlbum={(album) => push({ name: "album", album })}
                    onSearch={(videos) => push({ name: "search", videos })}
                    onDisconnect={onDisconnect}
                    onSignOut={session ? onSignOut : undefined}
                />
            );
        case "album":
            return <AlbumScreen client={client!} album={route.album} onPlay={playAlbum} />;
        case "show":
            return <ShowScreen client={client!} show={route.show} onPlay={playVideo} />;
        case "search":
            return (
                <SearchScreen
                    client={client!}
                    videos={route.videos}
                    onPlayVideo={playVideo}
                    onOpenShow={(show) => push({ name: "show", show })}
                    onOpenAlbum={(album) => push({ name: "album", album })}
                />
            );
        case "title":
            return (
                <TitleScreen
                    key={`${route.kind}:${route.tmdbId}`}
                    client={client!}
                    media={media!}
                    kind={route.kind}
                    tmdbId={route.tmdbId}
                    seed={route.seed}
                    onPlay={playFromTitle}
                    onOpenTitle={openTitle}
                />
            );
        case "player":
            return (
                <PlayerScreen
                    client={client!}
                    media={media}
                    item={route.item}
                    queue={route.queue}
                    index={route.index}
                    onExit={() => { if (!pop()) setRoute({ name: "home" }); }}
                />
            );
    }
}
