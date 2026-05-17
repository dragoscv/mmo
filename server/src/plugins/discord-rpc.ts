/**
 * Discord Rich Presence — companion-side.
 *
 * Web app emits "now watching" events over SSE; this module pushes them
 * to the Discord IPC socket via discord-rpc. Requires Discord client
 * to be running locally. Failures are silent (rich presence is a polish
 * feature, not a critical path).
 */

import { EventEmitter } from "node:events";

interface PresenceState {
    type: "movie" | "episode" | "music" | "idle";
    title?: string;
    subtitle?: string;
    posterUrl?: string;
    progressSec?: number;
    durationSec?: number;
    paused?: boolean;
}

const bus = new EventEmitter();
let connected = false;
let clientId: string | null = null;
let rpcClient: { setActivity: (a: Record<string, unknown>) => void; destroy: () => Promise<void>; login: (o: { clientId: string }) => Promise<void> } | null = null;

export async function initDiscordRpc(id: string | undefined): Promise<void> {
    if (!id) return;
    if (connected && clientId === id) return;
    if (rpcClient) {
        try { await rpcClient.destroy(); } catch { /* ignore */ }
        rpcClient = null;
        connected = false;
    }
    try {
        // Lazy import: optional dep, must not crash if missing.
        // discord-rpc has no shipped types; cast through unknown.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error -- discord-rpc has no types
        const mod = await import("discord-rpc");
        const Client = (mod as { Client: new (o: { transport: string }) => NonNullable<typeof rpcClient> }).Client;
        const c = new Client({ transport: "ipc" });
        await c.login({ clientId: id });
        rpcClient = c;
        clientId = id;
        connected = true;
    } catch {
        connected = false;
    }
}

export function setPresence(state: PresenceState): void {
    bus.emit("state", state);
    if (!rpcClient || !connected) return;
    try {
        if (state.type === "idle") {
            rpcClient.setActivity({});
            return;
        }
        const activity: Record<string, unknown> = {
            details: state.title,
            state: state.subtitle,
            largeImageKey: state.posterUrl,
            largeImageText: state.title,
            instance: false,
        };
        if (state.progressSec !== undefined && state.durationSec && !state.paused) {
            const now = Math.floor(Date.now() / 1000);
            activity.startTimestamp = now - Math.floor(state.progressSec);
            activity.endTimestamp = now + Math.floor(state.durationSec - state.progressSec);
        }
        rpcClient.setActivity(activity);
    } catch {
        connected = false;
    }
}

export async function shutdownDiscordRpc(): Promise<void> {
    if (!rpcClient) return;
    try { await rpcClient.destroy(); } catch { /* ignore */ }
    rpcClient = null;
    connected = false;
}

export function rpcBus(): EventEmitter {
    return bus;
}
