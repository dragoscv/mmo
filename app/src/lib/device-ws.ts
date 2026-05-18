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

type ScanProgressListener = (msg: { type: "scan:progress"; job: unknown }) => void;
type WatchEventListener = (msg: { type: "watch:event"; event: unknown }) => void;
type ConnectionListener = (connected: boolean) => void;

export interface DeviceWsClient {
    onScanProgress(fn: ScanProgressListener): () => void;
    onWatchEvent(fn: WatchEventListener): () => void;
    onConnection(fn: ConnectionListener): () => void;
    close(): void;
}

export function connectDeviceWs(tunnelHostname: string): DeviceWsClient {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByUser = false;
    let backoffMs = 1000;
    const scanListeners = new Set<ScanProgressListener>();
    const watchListeners = new Set<WatchEventListener>();
    const connListeners = new Set<ConnectionListener>();

    const open = () => {
        if (closedByUser) return;
        const url = `wss://${tunnelHostname}/ws`;
        try {
            const sock = new WebSocket(url);
            ws = sock;
            sock.onopen = () => {
                backoffMs = 1000;
                for (const fn of connListeners) fn(true);
            };
            sock.onclose = () => {
                ws = null;
                for (const fn of connListeners) fn(false);
                if (!closedByUser) {
                    reconnectTimer = setTimeout(open, backoffMs);
                    backoffMs = Math.min(backoffMs * 2, 30_000);
                }
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
                    }
                } catch { /* ignore malformed */ }
            };
        } catch {
            ws = null;
            if (!closedByUser) {
                reconnectTimer = setTimeout(open, backoffMs);
                backoffMs = Math.min(backoffMs * 2, 30_000);
            }
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
        close() {
            closedByUser = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
            scanListeners.clear();
            watchListeners.clear();
            connListeners.clear();
        },
    };
}
