"use client";

/**
 * MMO Server clients for the WP16 media surfaces. Mounted by `app/media/layout.tsx` with the
 * connections resolved server-side (`getMmoConnections`). Starts the hub once (remote control,
 * "Play on TV", Watch Together) and exposes the active profile so pages re-render on switch.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useHost, useRouter } from "@/components/host/host-context";
import { internalPathname } from "@/lib/host/products";
import type { MmoConnection } from "@/actions/mmo";
import { playHref } from "./player/model";
import { makeClients, type MmoClients } from "@/lib/mmo/clients";
import {
    EMPTY_GUEST_STATE, guestConnections, hostLabel, isGuestConnection, readGuestState, subscribeGuestState,
    withActive, withoutServer, writeGuestState,
} from "@/lib/mmo/guest-server";
import type { HubStatus } from "@/lib/mmo/hub";
import type { HubDevice, Profile } from "@/lib/mmo/media-types";

export interface MmoContextValue {
    clients: MmoClients | null;
    server: MmoConnection | null;
    /** Account servers first, then servers connected without an account (D59). */
    servers: MmoConnection[];
    /** True when the active server was connected in this browser without an account. */
    guest: boolean;
    /** Signed in to a MixAI account (servers from the account are available). */
    signedIn: boolean;
    /** Make another server active (account or guest). */
    selectServer(key: string): void;
    /** Forget a guest server in this browser. */
    forgetGuest(baseUrl: string): void;
    profile: Profile | null;
    /** True once `profiles.restore()` finished (gate can decide). */
    profilesReady: boolean;
    /** Restore said a picker is needed (several profiles, or PIN without token). */
    needsPicker: boolean;
    hubStatus: HubStatus;
    devices: HubDevice[];
    /** Re-evaluate after select/unlock/sign-out. */
    profileChanged(): void;
}

const Ctx = createContext<MmoContextValue | null>(null);

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0";

/** Hub `play {kind, tmdbId, fileId?, season?, episode?, startSec?}` → player route (null when not a title). */
export function hubPlayHref(args: Record<string, unknown>): string | null {
    const kind = args.kind === "movie" || args.kind === "tv" ? args.kind : null;
    const tmdbId = typeof args.tmdbId === "number" && args.tmdbId > 0 ? Math.floor(args.tmdbId) : null;
    if (!kind || !tmdbId) return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
    return playHref({
        kind, tmdbId,
        file: typeof args.fileId === "string" ? args.fileId : undefined,
        season: n(args.season), episode: n(args.episode), startSec: n(args.startSec),
    });
}

/** Stable key of a connection for selection: deviceId + baseUrl. */
export function connectionKey(c: MmoConnection): string {
    return `${c.deviceId}|${c.baseUrl}`;
}

const SELECTED_KEY = "mixai-web:selected-server";
const noopSub = () => () => undefined;

function readSelected(): string | null {
    try { return sessionStorage.getItem(SELECTED_KEY); } catch { return null; }
}

export function MmoProvider({ servers: accountServers, signedIn = true, children }: { servers: MmoConnection[]; signedIn?: boolean; children: ReactNode }) {
    const router = useRouter();
    const { kind: hostKindNow } = useHost();
    const guestState = useSyncExternalStore(subscribeGuestState, readGuestState, () => EMPTY_GUEST_STATE);
    const [selected, setSelected] = useState<string | null>(null);
    const storedSelected = useSyncExternalStore(noopSub, readSelected, () => null);
    const servers = useMemo(() => {
        const guests = guestConnections(guestState).filter((g) => !accountServers.some((a) => a.baseUrl === g.baseUrl));
        return [...accountServers, ...guests];
    }, [accountServers, guestState]);
    const want = selected ?? storedSelected;
    const server = servers.find((s) => connectionKey(s) === want)
        ?? accountServers.find((s) => s.online) ?? accountServers[0]
        ?? servers.find((s) => isGuestConnection(s)) ?? null;
    // The account's primary server keeps the legacy (unscoped) storage keys; everything else is scoped by host.
    const primary = accountServers.find((s) => s.online) ?? accountServers[0] ?? null;
    const scope = server && primary && connectionKey(server) === connectionKey(primary) ? "" : server ? hostLabel(server.baseUrl) : "";
    const key = server ? `${connectionKey(server)}|${scope}` : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only when the target server changes
    const clients = useMemo(() => (server ? makeClients({ baseUrl: server.baseUrl, token: server.token, userId: server.userId, scope }, APP_VERSION) : null), [key]);
    const [profile, setProfile] = useState<Profile | null>(null);
    const [readyKey, setReadyKey] = useState("");
    const [needsPicker, setNeedsPicker] = useState(false);
    const [hubStatus, setHubStatus] = useState<HubStatus>("disconnected");
    const [devices, setDevices] = useState<HubDevice[]>([]);

    useEffect(() => {
        if (!clients) return;
        let alive = true;
        const offP = clients.profiles.changed.on((p) => setProfile(p));
        void clients.profiles.restore().then((usable) => {
            if (!alive) return;
            setProfile(clients.profiles.active);
            setNeedsPicker(!usable || clients.profiles.needsPicker());
            setReadyKey(key);
        });
        const offS = clients.hub.statusChanged.on(setHubStatus);
        const offD = clients.hub.devicesChanged.on(setDevices);
        // "Play on this browser" from a phone/TV while not on the player (the player acks its own commands).
        const offC = clients.hub.commands.on((c) => {
            if (c.action !== "play" || internalPathname(location.pathname, hostKindNow).startsWith("/media/play/")) return;
            const href = hubPlayHref(c.args);
            if (!href) { clients.hub.ack(c.seq, false, "unsupported"); return; }
            clients.hub.ack(c.seq, true);
            router.push(href);
        });
        clients.hub.start();
        return () => { alive = false; offP(); offS(); offD(); offC(); clients.hub.stop(); };
    }, [clients, router, hostKindNow, key]);

    const selectServer = useCallback((k: string) => {
        setSelected(k);
        try { sessionStorage.setItem(SELECTED_KEY, k); } catch { /* ignore */ }
        const g = servers.find((s) => connectionKey(s) === k);
        if (g && isGuestConnection(g)) writeGuestState(withActive(readGuestState(), g.baseUrl));
    }, [servers]);

    const forgetGuest = useCallback((baseUrl: string) => {
        writeGuestState(withoutServer(readGuestState(), baseUrl));
        setSelected(null);
        try { sessionStorage.removeItem(SELECTED_KEY); } catch { /* ignore */ }
    }, []);

    const profilesReady = readyKey === key && key !== "";
    const value = useMemo<MmoContextValue>(() => ({
        clients, server, servers, guest: isGuestConnection(server), signedIn, selectServer, forgetGuest,
        profile, profilesReady: profilesReady || !clients, needsPicker, hubStatus, devices,
        profileChanged() {
            if (!clients) return;
            setProfile(clients.profiles.active);
            setNeedsPicker(clients.profiles.needsPicker());
            clients.media.invalidate();
            clients.hub.refreshHello();
        },
    }), [clients, server, servers, signedIn, selectServer, forgetGuest, profile, profilesReady, needsPicker, hubStatus, devices]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMmo(): MmoContextValue {
    const v = useContext(Ctx);
    if (!v) throw new Error("useMmo outside <MmoProvider>");
    return v;
}
