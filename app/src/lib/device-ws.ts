/**
 * Device WebSocket client for the per-device Cloudflare Tunnel.
 *
 * Why a separate client from `NativeCompanionClient`:
 *  - NativeCompanionClient targets http://localhost:17899 (the local
 *    audio engine path) and is one-per-page.
 *  - This client targets wss://device-<hex>.muzicai.ro/ws and is
 *    one-per-remote-device. Lives in the Devices page to surface live
 *    scan progress + watcher events without the 750 ms pull loop.
 *
 * Auth model: companion's WS upgrade gates on `Origin` only (token-less)
 * because tokens can't ride the WS handshake headers. The CF Tunnel +
 * companion origin allowlist together restrict who can connect.
 *
 * Failure mode: same as `directFetch` — never throws. On any error the
 * caller's existing poll loop keeps the UI live (just at higher latency).
 */

import { ReconnectingTimer } from "./ws-backoff";

type ScanProgressListener = (msg: { type: "scan:progress"; job: unknown }) => void;
type WatchEventListener = (msg: { type: "watch:event"; event: unknown }) => void;
type ConnectionListener = (connected: boolean) => void;

export interface DeviceLogEntry {
    ts: number;
    level: "info" | "warn" | "error";
    line: string;
}
type LogListener = (entries: DeviceLogEntry[], kind: "snapshot" | "live") => void;

export interface DeviceWsClient {
    onScanProgress(fn: ScanProgressListener): () => void;
    onWatchEvent(fn: WatchEventListener): () => void;
    onConnection(fn: ConnectionListener): () => void;
    onLog(fn: LogListener): () => void;
    close(): void;
}

export function connectDeviceWs(tunnelHostname: string): DeviceWsClient {
    let ws: WebSocket | null = null;
    let closedByUser = false;
    const reconnect = new ReconnectingTimer({ initialMs: 1000, maxMs: 30_000 });
    const scanListeners = new Set<ScanProgressListener>();
    const watchListeners = new Set<WatchEventListener>();
    const connListeners = new Set<ConnectionListener>();
    const logListeners = new Set<LogListener>();

    const open = () => {
        if (closedByUser) return;
        const url = `wss://${tunnelHostname}/ws`;
        try {
            const sock = new WebSocket(url);
            ws = sock;
            sock.onopen = () => {
                reconnect.reset();
                for (const fn of connListeners) fn(true);
            };
            sock.onclose = () => {
                ws = null;
                for (const fn of connListeners) fn(false);
                if (!closedByUser) reconnect.schedule(open);
            };
            sock.onerror = () => { /* close handler does cleanup */ };
            sock.onmessage = (ev) => {
                if (typeof ev.data !== "string") return; // skip binary level frames
                try {
                    const msg = JSON.parse(ev.data) as { type?: string };
                    if (msg.type === "scan:progress") {
                        for (const fn of scanListeners) fn(msg as Parameters<ScanProgressListener>[0]);
                    } else if (msg.type === "watch:event") {
                        for (const fn of watchListeners) fn(msg as Parameters<WatchEventListener>[0]);
                    } else if (msg.type === "log:line") {
                        const entries = (msg as { entries?: unknown }).entries;
                        if (Array.isArray(entries) && entries.length > 0) {
                            for (const fn of logListeners) fn(entries as DeviceLogEntry[], "live");
                        }
                    } else if (msg.type === "log:snapshot") {
                        const lines = (msg as { lines?: unknown }).lines;
                        if (Array.isArray(lines) && lines.length > 0) {
                            // Server sends raw "[iso] [level] text" strings — wrap
                            // into DeviceLogEntry so the UI doesn't branch shapes.
                            const entries: DeviceLogEntry[] = lines
                                .filter((l): l is string => typeof l === "string")
                                .map((line) => parseLogLine(line));
                            for (const fn of logListeners) fn(entries, "snapshot");
                        }
                    }
                } catch { /* ignore malformed */ }
            };
        } catch {
            ws = null;
            if (!closedByUser) reconnect.schedule(open);
        }
    };

    open();

    return {
        onScanProgress(fn) {
            scanListeners.add(fn);
            return () => { scanListeners.delete(fn); };
        },
        onWatchEvent(fn) {
            watchListeners.add(fn);
            return () => { watchListeners.delete(fn); };
        },
        onConnection(fn) {
            connListeners.add(fn);
            return () => { connListeners.delete(fn); };
        },
        onLog(fn) {
            logListeners.add(fn);
            return () => { logListeners.delete(fn); };
        },
        close() {
            closedByUser = true;
            reconnect.cancel();
            if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
            scanListeners.clear();
            watchListeners.clear();
            connListeners.clear();
            logListeners.clear();
        },
    };
}

/** Parse a server-side debug-ring line ("[iso] [level] message") back
 *  into the structured shape the UI consumes. Falls back to "info" with
 *  Date.now() when the prefix isn't recognised — keeps the console
 *  resilient to format drift. */
function parseLogLine(line: string): DeviceLogEntry {
    const m = /^\[([^\]]+)\]\s+\[(info|warn|error)\]\s?(.*)$/i.exec(line);
    if (!m) return { ts: Date.now(), level: "info", line };
    const ts = Date.parse(m[1]!);
    const level = m[2]!.toLowerCase() as DeviceLogEntry["level"];
    return { ts: Number.isFinite(ts) ? ts : Date.now(), level, line };
}
