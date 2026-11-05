"use client";

/**
 * Watch Together member logic for the web player (port of tv-tizen `screens/player/useRoomSync.ts`).
 *  - The room follows this player when `room.media.fileId` equals the playing file.
 *  - A host (or anyone in a room without media) loads the file it plays into the room.
 *  - `room:state` → `roomApply` (schedule play at the server-clock anchor / join a running play / pause).
 *  - Every 1 s while playing: `room:report` + `followerAction` (playbackRate ±5 % under 1.5 s drift, hard seek above).
 *  - `waiting`/`stalled` → `room:ready false`; `playing`/`canplay`/`seeked` → `room:ready true` (on change only).
 * Local transport inside a room goes through `play/pause/seek` (the server schedules everyone).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { HubClient, RoomChat, RoomReaction, RoomState } from "@/lib/mmo/hub";
import type { HubMedia } from "@/lib/mmo/media-types";
import { followerAction, roomApply } from "./model";

export interface RoomSyncDeps {
    hub: HubClient | null;
    fileId: string | null;
    media: HubMedia | null;
    /** Guests never load media into the room (server ignores it too). */
    canLoad: boolean;
    getEl(): HTMLVideoElement | null;
    absTime(): number;
    seekAbs(sec: number): void;
    baseRate(): number;
    onChat(c: RoomChat): void;
    onReaction(r: RoomReaction): void;
}

export interface RoomSync {
    inRoom: boolean;
    room: RoomState | null;
    waiting: boolean;
    play(): void;
    pause(): void;
    seek(sec: number): void;
}

export function useRoomSync(d: RoomSyncDeps): RoomSync {
    const { hub, fileId } = d;
    const dref = useRef(d);
    useEffect(() => { dref.current = d; });
    const [room, setRoom] = useState<RoomState | null>(() => hub?.room ?? null);
    const playTimer = useRef<number | null>(null);
    const correcting = useRef(false);
    const lastReady = useRef<boolean | null>(null);
    const loadedFor = useRef<string | null>(null);

    useEffect(() => {
        if (!hub) return;
        const offRoom = hub.roomChanged.on((r) => setRoom(r));
        const offChat = hub.chat.on((c) => dref.current.onChat(c));
        const offReact = hub.reactions.on((r) => dref.current.onReaction(r));
        const sync = window.setTimeout(() => setRoom(hub.room), 0);
        return () => { offRoom(); offChat(); offReact(); window.clearTimeout(sync); };
    }, [hub]);

    const inRoom = !!hub && !!room && !!fileId && room.media?.fileId === fileId;
    const roomId = room?.roomId ?? null;
    const roomFile = room?.media?.fileId ?? null;
    const hostConn = room?.hostConnId ?? null;
    const hasMedia = !!room?.media;

    useEffect(() => {
        if (!hub || !roomId || !fileId || !d.media || !d.canLoad) return;
        if (roomFile === fileId || loadedFor.current === `${roomId}:${fileId}`) return;
        const host = !hostConn || hostConn === hub.myConnId;
        if (hasMedia && !host) return;
        loadedFor.current = `${roomId}:${fileId}`;
        hub.load(d.media, Math.max(0, dref.current.absTime()));
    }, [hub, roomId, roomFile, hostConn, hasMedia, fileId, d.media, d.canLoad]);

    const phase = room?.phase;
    const atMs = room?.anchor.atServerMs;
    const atPos = room?.anchor.positionSec;
    const atPlaying = room?.anchor.playing;
    useEffect(() => {
        if (!inRoom || !hub || !hub.room) return;
        const el = dref.current.getEl();
        if (!el) return;
        if (playTimer.current) { window.clearTimeout(playTimer.current); playTimer.current = null; }
        const r = hub.room;
        const act = roomApply(r.phase === "playing", r.anchor, hub.serverNowMs(), dref.current.absTime());
        if (act.seekTo !== null) dref.current.seekAbs(act.seekTo);
        if (act.kind === "schedule") {
            el.pause();
            playTimer.current = window.setTimeout(() => { el.play().catch(() => undefined); }, act.delayMs);
        } else if (act.kind === "play") {
            el.play().catch(() => undefined);
        } else {
            el.pause();
        }
        return () => { if (playTimer.current) { window.clearTimeout(playTimer.current); playTimer.current = null; } };
    }, [inRoom, hub, phase, atMs, atPos, atPlaying]);

    useEffect(() => {
        if (!inRoom || !hub) return;
        const h = window.setInterval(() => {
            const el = dref.current.getEl();
            const r = hub.room;
            if (!el || !r) return;
            if (r.phase !== "playing" || el.paused || el.seeking || el.readyState < 3) return;
            const actual = dref.current.absTime();
            hub.report(actual);
            const act = followerAction(actual, r.anchor, hub.serverNowMs(), correcting.current);
            if (act.kind === "rate") { correcting.current = true; el.playbackRate = act.rate; }
            else if (act.kind === "seek") { correcting.current = false; el.playbackRate = 1; dref.current.seekAbs(act.positionSec); }
            else { correcting.current = false; if (el.playbackRate !== 1) el.playbackRate = 1; }
        }, 1000);
        return () => {
            window.clearInterval(h);
            const el = dref.current.getEl();
            if (el) el.playbackRate = dref.current.baseRate();
            correcting.current = false;
        };
    }, [inRoom, hub]);

    useEffect(() => {
        if (!inRoom || !hub) return;
        const el = dref.current.getEl();
        if (!el) return;
        const set = (ready: boolean) => {
            if (lastReady.current === ready) return;
            lastReady.current = ready;
            hub.ready(ready, dref.current.absTime());
        };
        const notReady = () => set(false);
        const isReady = () => set(true);
        const evs: Array<[string, () => void]> = [["waiting", notReady], ["stalled", notReady], ["playing", isReady], ["canplay", isReady], ["seeked", isReady]];
        for (const [n, f] of evs) el.addEventListener(n, f);
        set(el.readyState >= 3);
        return () => {
            for (const [n, f] of evs) el.removeEventListener(n, f);
            lastReady.current = null;
        };
    }, [inRoom, hub]);

    return useMemo<RoomSync>(() => ({
        inRoom,
        room,
        waiting: inRoom && room?.phase === "waiting",
        play: () => { hub?.play(dref.current.absTime()); },
        pause: () => {
            if (!hub) return;
            hub.pause(dref.current.absTime());
            dref.current.getEl()?.pause();
        },
        seek: (sec: number) => {
            if (!hub) return;
            hub.seek(sec);
            dref.current.seekAbs(sec);
        },
    }), [inRoom, room, hub]);
}
