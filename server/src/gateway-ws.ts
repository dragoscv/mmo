/**
 * Companion WebSocket client for the MuzicAI gateway.
 *
 * Replaces the 3s HTTP announce poll with a persistent connection when the
 * gateway exposes /ws. Benefits: instant online/offline (the gateway flips
 * the device offline the moment this socket drops), zero polling overhead,
 * and lower latency for command dispatch.
 *
 * Design:
 *  - Connects to `${gatewayUrl}/ws` with `Authorization: Bearer <token>`.
 *  - Sends a heartbeat every HEARTBEAT_MS with lanUrl/hostname/os/version +
 *    any pending command results, and an ACK of the current tunnel host so
 *    the server only resends the secret when it changes.
 *  - Handles inbound `welcome` / `commands` / `tunnelBootstrap` via the
 *    shared `handleControlPayload`, posting results back over the socket.
 *  - Reconnects with capped exponential backoff. While the socket is up it
 *    signals the HTTP loop to stand down (and resumes it on give-up).
 *  - On repeated failures it gives up and lets the HTTP announce loop take
 *    over, so a gateway that lacks /ws (or is unreachable) never breaks
 *    liveness — graceful degradation.
 */

import os from "node:os";
import WebSocket from "ws";
import { getSettings, store } from "./store";
import { log } from "./logger";
import type { OutboundResult } from "./command-worker";
import {
    buildLanUrl,
    getCurrentVersion,
    getPendingResults,
    handleControlPayload,
    notifyAuthInvalidated,
    requeueResults,
    type ControlPayload,
} from "./lan-announce";

const HEARTBEAT_MS = 25_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** Give up on WS after this many consecutive failed connects; fall back to
 *  the HTTP announce loop until the next app restart / manual retry. */
const MAX_CONSECUTIVE_FAILURES = 6;

let ws: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let failures = 0;
let stopped = true;
let connected = false;
let currentPort = 0;
let onWsActiveCb: ((active: boolean) => void) | null = null;

/** Called when the WS becomes the active transport (true) or steps down
 *  (false) so the HTTP announce loop can pause/resume. */
export function setOnWsActive(cb: ((active: boolean) => void) | null): void {
    onWsActiveCb = cb;
}

export function isGatewayWsConnected(): boolean {
    return connected;
}

function clearTimers(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function wsUrl(gatewayUrl: string): string {
    const u = new URL("/ws", gatewayUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
}

function sendHeartbeat(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const lanUrl = currentPort ? buildLanUrl(currentPort) : null;
    const results = getPendingResults();
    const tunnelHostnameAck = (store.get("tunnelHostname") as string | undefined) || null;
    try {
        ws.send(JSON.stringify({
            type: "hb",
            lanUrl,
            hostname: os.hostname(),
            os: process.platform,
            version: getCurrentVersion(),
            tunnelHostnameAck,
        }));
        if (results.length > 0) {
            ws.send(JSON.stringify({ type: "results", results }));
        }
    } catch (err) {
        // Re-queue results so a failed send doesn't drop them.
        if (results.length > 0) requeueResults(results);
        log("warn", "[gateway-ws] heartbeat send failed:", err);
    }
}

async function onMessage(raw: WebSocket.RawData): Promise<void> {
    let msg: (ControlPayload & { type?: string }) | null;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg) return;
    // welcome / commands / tunnelBootstrap all map onto ControlPayload.
    const results = await handleControlPayload(msg);
    if (results.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "results", results })); }
        catch { requeueResults(results); }
    }
}

function scheduleReconnect(): void {
    if (stopped) return;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
        log("warn", `[gateway-ws] giving up after ${failures} failures — falling back to HTTP announce`);
        if (onWsActiveCb) { try { onWsActiveCb(false); } catch { /* ignore */ } }
        return;
    }
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => { connect(); }, delay);
}

function connect(): void {
    if (stopped) return;
    const settings = getSettings();
    const gatewayUrl = settings.gatewayUrl;
    const token = store.get("deviceToken") as string | undefined;
    if (!gatewayUrl || !token) {
        // Not paired / no gateway — retry later; HTTP loop covers liveness.
        scheduleReconnect();
        return;
    }

    let socket: WebSocket;
    try {
        socket = new WebSocket(wsUrl(gatewayUrl), { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
        failures++;
        log("warn", "[gateway-ws] connect threw:", err);
        scheduleReconnect();
        return;
    }
    ws = socket;

    socket.on("open", () => {
        failures = 0;
        connected = true;
        log("info", "[gateway-ws] connected");
        if (onWsActiveCb) { try { onWsActiveCb(true); } catch { /* ignore */ } }
        sendHeartbeat();
        clearTimers();
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    });

    socket.on("message", (data) => { void onMessage(data); });

    socket.on("unexpected-response", (_req, res) => {
        if (res.statusCode === 401) {
            log("warn", "[gateway-ws] 401 — token rejected");
            notifyAuthInvalidated("ws-401");
        }
    });

    socket.on("close", (code) => {
        connected = false;
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        ws = null;
        if (stopped) return;
        failures++;
        log("info", `[gateway-ws] closed code=${code}; reconnecting (failure ${failures})`);
        scheduleReconnect();
    });

    socket.on("error", (err) => {
        log("warn", "[gateway-ws] error:", err instanceof Error ? err.message : err);
        // 'close' fires after 'error' and drives the reconnect.
    });
}

/** Start the WS client. `port` is the local server port used for lanUrl. */
export function startGatewayWs(port: number): void {
    stopped = false;
    currentPort = port;
    failures = 0;
    // Small initial delay so the pairing token is on disk first.
    reconnectTimer = setTimeout(() => { connect(); }, 4500);
}

export function stopGatewayWs(): void {
    stopped = true;
    connected = false;
    clearTimers();
    if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
    }
}

/** Drop any unused export to satisfy lint when results type isn't referenced. */
export type { OutboundResult };
