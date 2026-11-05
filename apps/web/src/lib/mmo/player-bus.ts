/**
 * Player bus: decouples whoever wants to control playback (hub remote commands, rail mini-player,
 * Watch Together) from the screen that owns the <video>/<audio> element (Player / LivePlay / NowPlaying).
 *
 *   playerBus.subscribe(handler)   — the active player registers; returns unsubscribe. Last subscriber wins.
 *   playerBus.send(cmd)            — true when a player handled it.
 *   playerBus.setNowPlaying(np)    — the player publishes state (≈ every timeupdate; cheap).
 *   playerBus.nowPlaying()         — current snapshot or null.
 *   playerBus.onNowPlaying(fn)     — listen to changes; returns unsubscribe.
 *   useNowPlaying()                — React hook (re-renders on change).
 */
import { useEffect, useState } from "react";
import { Emitter } from "./emitter";
import type { HubMedia } from "./media-types";

export type PlayerCommand =
    | { type: "pause" }
    | { type: "resume" }
    | { type: "toggle" }
    | { type: "seek"; positionSec: number }
    | { type: "seekBy"; deltaSec: number }
    | { type: "stop" }
    | { type: "next" }
    | { type: "previous" }
    | { type: "rate"; rate: number }
    | { type: "volume"; level: number };

export interface NowPlaying {
    kind: "video" | "audio" | "live";
    playing: boolean;
    positionSec: number;
    durationSec?: number;
    /** Sent to the hub as `state.media`. */
    media: HubMedia;
    title: string;
    subtitle?: string;
    /** Cover / poster URL for the mini-player chip. */
    artUrl?: string | null;
    updatedAt: number;
}

/** Returns true when handled. */
export type PlayerHandler = (cmd: PlayerCommand) => boolean | void;

class PlayerBus {
    private handlers: PlayerHandler[] = [];
    private np: NowPlaying | null = null;
    private readonly changes = new Emitter<NowPlaying | null>();

    subscribe(h: PlayerHandler): () => void {
        this.handlers.push(h);
        return () => { this.handlers = this.handlers.filter((x) => x !== h); };
    }

    send(cmd: PlayerCommand): boolean {
        const h = this.handlers[this.handlers.length - 1];
        if (!h) return false;
        return h(cmd) !== false;
    }

    get hasPlayer(): boolean { return this.handlers.length > 0; }

    nowPlaying(): NowPlaying | null { return this.np; }

    setNowPlaying(np: NowPlaying | null): void {
        this.np = np;
        this.changes.emit(np);
    }

    onNowPlaying(fn: (np: NowPlaying | null) => void): () => void { return this.changes.on(fn); }
}

export const playerBus = new PlayerBus();

export function useNowPlaying(): NowPlaying | null {
    const [np, setNp] = useState<NowPlaying | null>(() => playerBus.nowPlaying());
    useEffect(() => playerBus.onNowPlaying(setNp), []);
    return np;
}
