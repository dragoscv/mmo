/**
 * MixAI Music desktop bridge (WP17-43). Inside the Tauri shell (`ro.mixai.music.desktop`) the web music player
 * mirrors its state to the OS media controls / tray / mini player through the `desktop_media_update` command
 * (remote capability for music.mixai.ro), and the shell drives the player back through
 * `window.__mixaiDesktop.command(name, arg)` (fixed command set). Outside the shell everything is a no-op.
 */
import { isTauri, tauriInvoke } from "@/lib/tauri-bridge";
import type { WebMusicProgress, WebMusicState } from "./web-music-player";

export interface DesktopNowPlaying {
    title: string | null;
    artist: string | null;
    album: string | null;
    artUrl: string | null;
    playing: boolean;
    positionSec: number;
    durationSec: number;
}

export const DESKTOP_COMMANDS = ["toggle", "play", "pause", "next", "previous", "stop", "seekTo", "seekBy", "volume"] as const;
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

/** What the player must support for the shell to drive it. */
export interface DesktopPlayer {
    toggle(): void;
    resume(): void;
    pause(): void;
    next(): void;
    prev(): void;
    stop(): void;
    seek(sec: number): void;
    seekBy(delta: number): void;
    setVolume(v: number): void;
}

export function toDesktopNowPlaying(st: WebMusicState, p: WebMusicProgress, artUrl: string | null): DesktopNowPlaying {
    const t = st.hidden ? null : st.current;
    if (!t) return { title: null, artist: null, album: null, artUrl: null, playing: false, positionSec: 0, durationSec: 0 };
    return {
        title: t.title,
        artist: t.artist ?? null,
        album: t.album ?? null,
        artUrl,
        playing: st.playing,
        positionSec: Math.max(0, p.position || 0),
        durationSec: p.duration || t.durationSec || 0,
    };
}

/** Same track / play state and position within 2 s of the extrapolated one → no need to push again. */
export function sameNowPlaying(a: DesktopNowPlaying | null, b: DesktopNowPlaying, elapsedSec: number): boolean {
    if (!a) return false;
    if (a.title !== b.title || a.artist !== b.artist || a.album !== b.album || a.artUrl !== b.artUrl) return false;
    if (a.playing !== b.playing || a.durationSec !== b.durationSec) return false;
    const expected = a.positionSec + (a.playing ? elapsedSec : 0);
    return Math.abs(expected - b.positionSec) < 2;
}

/** Runs one shell command on the player. Unknown names and non-finite args are ignored. */
export function runDesktopCommand(player: DesktopPlayer, name: string, arg?: unknown): boolean {
    const n = typeof arg === "number" && Number.isFinite(arg) ? arg : null;
    switch (name as DesktopCommand) {
        case "toggle": player.toggle(); return true;
        case "play": player.resume(); return true;
        case "pause": player.pause(); return true;
        case "next": player.next(); return true;
        case "previous": player.prev(); return true;
        case "stop": player.stop(); return true;
        case "seekTo": if (n === null) return false; player.seek(Math.max(0, n)); return true;
        case "seekBy": if (n === null) return false; player.seekBy(n); return true;
        case "volume": if (n === null) return false; player.setVolume(Math.max(0, Math.min(1, n))); return true;
        default: return false;
    }
}

declare global {
    interface Window {
        __mixaiDesktop?: { command(name: string, arg?: number): boolean };
    }
}

const PUSH_EVERY_MS = 5000;

/**
 * Installs the bridge once (no-op outside Tauri). `snapshot` is read on every player change; pushes are
 * de-duplicated and refreshed every 5 s while playing so the OS position stays right.
 */
export function installDesktopBridge(player: DesktopPlayer, subscribe: (fn: () => void) => () => void, snapshot: () => DesktopNowPlaying): () => void {
    if (typeof window === "undefined" || !isTauri() || window.__mixaiDesktop) return () => undefined;
    window.__mixaiDesktop = { command: (name, arg) => runDesktopCommand(player, name, arg) };
    let last: DesktopNowPlaying | null = null;
    let lastAt = 0;
    const push = (force: boolean) => {
        const now = snapshot();
        const elapsed = (Date.now() - lastAt) / 1000;
        if (!force && sameNowPlaying(last, now, elapsed)) return;
        last = now;
        lastAt = Date.now();
        void tauriInvoke("desktop_media_update", { state: now });
    };
    const off = subscribe(() => push(false));
    const timer = setInterval(() => { if (last?.playing) push(true); }, PUSH_EVERY_MS);
    push(true);
    return () => { off(); clearInterval(timer); delete window.__mixaiDesktop; };
}

/** The shell's local launcher signs in through the system browser (Google blocks OAuth in webviews). */
export function isMusicDesktop(): boolean {
    return isTauri();
}

export async function openDesktopSignIn(): Promise<boolean> {
    return (await tauriInvoke("desktop_open_signin")) !== null;
}
