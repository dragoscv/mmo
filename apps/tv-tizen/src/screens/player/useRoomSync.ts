/**
 * Watch Together follower for the Player (WP16-27, port of tv-android PlayerScreen room logic).
 *  - The room's media fileId must match the playing file; otherwise the Player plays solo.
 *  - `room:state` → schedule play at `anchor.atServerMs` (server clock via `hub.serverNowMs()`), or pause/seek.
 *  - Every 1 s while playing: `driftAction` → `playbackRate` nudge (±5 %) or a hard seek (≥ 1.5 s), `room:report`.
 *  - `waiting` / `stalled` → `room:ready false`; `playing` / `canplay` → `room:ready true` (only on change).
 * Local user actions go through `roomPlay/roomPause/roomSeek` (the Player calls them instead of acting locally).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { HubClient, RoomChat, RoomReaction, RoomState } from "../../lib/hub";
import type { HubMedia } from "../../lib/media-types";
import { driftAction, expectedPosition } from "../../lib/sync-math";

export interface RoomSyncDeps {
    hub: HubClient | null;
    /** fileId of the playing video (null for audio / nothing). */
    fileId: string | null;
    media: HubMedia | null;
    getEl(): HTMLVideoElement | null;
    /** Absolute media position (s). */
    absTime(): number;
    /** Absolute seek (handles HLS session restarts). */
    seekAbs(sec: number): void;
    /** Playback rate chosen by the user (1 inside rooms). */
    baseRate(): number;
    onChat(c: RoomChat): void;
    onReaction(r: RoomReaction): void;
}

export interface RoomSync {
    /** The room follows this file. */
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
    dref.current = d;
    const [room, setRoom] = useState<RoomState | null>(() => hub?.room ?? null);
    const playTimer = useRef<number | null>(null);
    const correcting = useRef(false);
    const lastReady = useRef<boolean | null>(null);
    const loadedFor = useRef<string | null>(null);

    useEffect(() => {
        if (!hub) return;
        setRoom(hub.room);
        const offRoom = hub.roomChanged.on((r) => setRoom(r));
        const offChat = hub.chat.on((c) => dref.current.onChat(c));
        const offReact = hub.reactions.on((r) => dref.current.onReaction(r));
        return () => { offRoom(); offChat(); offReact(); };
    }, [hub]);

    const inRoom = !!hub && !!room && !!fileId && room.media?.fileId === fileId;

    // "Choose what to watch": a member of a room without media (or the host) loads the file it starts playing.
    useEffect(() => {
        if (!hub || !room || !fileId || !d.media) return;
        if (room.media?.fileId === fileId || loadedFor.current === `${room.roomId}:${fileId}`) return;
        const host = !room.hostConnId || room.hostConnId === hub.myConnId;
        if (room.media && !host) return;
        loadedFor.current = `${room.roomId}:${fileId}`;
        hub.load(d.media, Math.max(0, dref.current.absTime()));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hub, room?.roomId, room?.media?.fileId, fileId]);

    // Apply room state (play schedule / pause / seek).
    useEffect(() => {
        if (!inRoom || !hub || !room) return;
        const el = dref.current.getEl();
        if (!el) return;
        if (playTimer.current) { window.clearTimeout(playTimer.current); playTimer.current = null; }
        const a = room.anchor;
        const now = hub.serverNowMs();
        const actual = dref.current.absTime();
        if (room.phase === "playing" && a.playing) {
            if (a.atServerMs > now + 30) {
                if (Math.abs(actual - a.positionSec) > 0.3) dref.current.seekAbs(a.positionSec);
                el.pause();
                playTimer.current = window.setTimeout(() => { el.play().catch(() => undefined); }, a.atServerMs - now);
            } else {
                const exp = expectedPosition(a, now);
                if (Math.abs(actual - exp) > 1) dref.current.seekAbs(exp);
                el.play().catch(() => undefined);
            }
        } else {
            el.pause();
            if (Math.abs(actual - a.positionSec) > 0.5) dref.current.seekAbs(a.positionSec);
        }
        return () => { if (playTimer.current) { window.clearTimeout(playTimer.current); playTimer.current = null; } };
    }, [inRoom, hub, room?.phase, room?.anchor.atServerMs, room?.anchor.positionSec, room?.anchor.playing]); // eslint-disable-line react-hooks/exhaustive-deps

    // Drift correction + 1 Hz report.
    useEffect(() => {
        if (!inRoom || !hub) return;
        const h = window.setInterval(() => {
            const el = dref.current.getEl();
            const r = hub.room;
            if (!el || !r) return;
            const actual = dref.current.absTime();
            if (r.phase !== "playing" || el.paused || el.seeking || el.readyState < 3) return;
            hub.report(actual);
            const exp = expectedPosition(r.anchor, hub.serverNowMs());
            const act = driftAction(actual, exp, correcting.current);
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

    // Buffering → ready flags.
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
        el.addEventListener("waiting", notReady);
        el.addEventListener("stalled", notReady);
        el.addEventListener("playing", isReady);
        el.addEventListener("canplay", isReady);
        el.addEventListener("seeked", isReady);
        if (el.readyState >= 3) set(true); else set(false);
        return () => {
            el.removeEventListener("waiting", notReady);
            el.removeEventListener("stalled", notReady);
            el.removeEventListener("playing", isReady);
            el.removeEventListener("canplay", isReady);
            el.removeEventListener("seeked", isReady);
            lastReady.current = null;
        };
    }, [inRoom, hub]);

    // Stable between room changes so the Player's key/bus effects do not re-subscribe on every render.
    return useMemo<RoomSync>(() => ({
        inRoom,
        room,
        waiting: inRoom && room?.phase === "waiting",
        play: () => { if (hub) hub.play(dref.current.absTime()); },
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
