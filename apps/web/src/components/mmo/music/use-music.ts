"use client";

/**
 * Music hooks (WP16-40): `useMusic()` binds the web music engine to the current server + profile and returns
 * the `MusicClient`; `useLoad()` is a tiny keyed async loader with loading / error / ready states + retry.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicClient } from "@/lib/mmo/music";
import { scopeOf } from "@/lib/mmo/offline/keys";
import { webMusicPlayer } from "@/lib/mmo/web-music-player";
import { useMmo } from "../mmo-provider";
import { useOfflineList } from "../offline/use-offline";

export function useMusic(): { music: MusicClient | null; profileKey: string } {
    const { clients, profile, server } = useMmo();
    const profileId = profile?.id ?? null;
    useEffect(() => {
        if (clients) webMusicPlayer.attach(clients.music, clients.media, profileId);
    }, [clients, profileId]);
    // Finished track downloads of this server + profile play from the device (offline-first).
    const scope = server && clients ? scopeOf(server.deviceId, clients.profiles.profileId) : null;
    const { items } = useOfflineList(scope);
    useEffect(() => {
        const m = new Map<string, string>();
        for (const i of items ?? []) if (i.kind === "track" && i.status === "done") m.set(i.id, i.key);
        webMusicPlayer.setOffline(m);
    }, [items]);
    return { music: clients?.music ?? null, profileKey: profileId ?? "default" };
}

export interface DownloadScope { serverId: string; profileId: string; album?: string | null }

/** Server + profile for offline downloads (`TrackList.downloadable`), `undefined` until both are known. */
export function useDownloadable(album?: string | null): DownloadScope | undefined {
    const { server, clients } = useMmo();
    if (!server || !clients) return undefined;
    return { serverId: server.deviceId, profileId: clients.profiles.profileId, album: album ?? null };
}

export type LoadStatus = "loading" | "error" | "ready";

export interface Loaded<T> {
    status: LoadStatus;
    data: T | null;
    retry(): void;
}

/** Runs `fn` whenever `key` changes (null key = wait). Late results of a previous key are dropped. */
export function useLoad<T>(key: string | null, fn: () => Promise<T>): Loaded<T> {
    const fnRef = useRef(fn);
    useEffect(() => { fnRef.current = fn; });
    const [tick, setTick] = useState(0);
    const [res, setRes] = useState<{ key: string | null; status: LoadStatus; data: T | null }>({ key: null, status: "loading", data: null });
    const reqKey = key === null ? null : `${key}#${tick}`;

    useEffect(() => {
        if (reqKey === null) return;
        let alive = true;
        fnRef.current().then(
            (data) => { if (alive) setRes({ key: reqKey, status: "ready", data }); },
            () => { if (alive) setRes({ key: reqKey, status: "error", data: null }); },
        );
        return () => { alive = false; };
    }, [reqKey]);

    const retry = useCallback(() => setTick((n) => n + 1), []);
    const stale = res.key !== reqKey;
    return { status: stale ? "loading" : res.status, data: stale ? null : res.data, retry };
}

