"use client";

/**
 * MMO Server clients for the WP16 media surfaces. Mounted by `app/media/layout.tsx` with the
 * connections resolved server-side (`getMmoConnections`). Starts the hub once (remote control,
 * "Play on TV", Watch Together) and exposes the active profile so pages re-render on switch.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useHost, useRouter } from "@/components/host/host-context";
import { internalPathname } from "@/lib/host/products";
import type { MmoConnection } from "@/actions/mmo";
import { playHref } from "./player/model";
import { makeClients, type MmoClients } from "@/lib/mmo/clients";
import type { HubStatus } from "@/lib/mmo/hub";
import type { HubDevice, Profile } from "@/lib/mmo/media-types";

export interface MmoContextValue {
    clients: MmoClients | null;
    server: MmoConnection | null;
    servers: MmoConnection[];
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

export function MmoProvider({ servers, children }: { servers: MmoConnection[]; children: ReactNode }) {
    const router = useRouter();
    const { kind: hostKindNow } = useHost();
    const server = servers.find((s) => s.online) ?? servers[0] ?? null;
    const key = server ? `${server.deviceId}|${server.baseUrl}` : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only when the target server changes
    const clients = useMemo(() => (server ? makeClients({ baseUrl: server.baseUrl, token: server.token, userId: server.userId }, APP_VERSION) : null), [key]);
    const [profile, setProfile] = useState<Profile | null>(null);
    const [profilesReady, setReady] = useState(false);
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
            setReady(true);
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
    }, [clients, router, hostKindNow]);

    const value = useMemo<MmoContextValue>(() => ({
        clients, server, servers, profile, profilesReady: profilesReady || !clients, needsPicker, hubStatus, devices,
        profileChanged() {
            if (!clients) return;
            setProfile(clients.profiles.active);
            setNeedsPicker(clients.profiles.needsPicker());
            clients.media.invalidate();
            clients.hub.refreshHello();
        },
    }), [clients, server, servers, profile, profilesReady, needsPicker, hubStatus, devices]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMmo(): MmoContextValue {
    const v = useContext(Ctx);
    if (!v) throw new Error("useMmo outside <MmoProvider>");
    return v;
}
