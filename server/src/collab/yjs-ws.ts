/**
 * Companion Yjs WebSocket bridge.
 *
 * Mounts a `/yjs` WebSocket endpoint on the companion HTTP server so
 * web clients can establish Yjs sessions even when offline from the
 * cloud relay. Rooms are scoped per URL path: `/yjs/{room}`. Inside a
 * room the companion just shuttles Yjs binary frames between peers —
 * persistence is the web app's IndexedDB and (when reachable) the
 * cloud Postgres `yjs_state` columns.
 *
 * This handler intentionally does NOT persist Y.Doc state on disk yet:
 * the companion's authoritative storage is SQLite per-row, and Y.Doc
 * binary blobs are written back through the regular sync channel on
 * idle by the web app. A future PR can add a Y.PersistenceProvider
 * backed by better-sqlite3 if we want true offline collab between two
 * LAN clients with the cloud unreachable.
 *
 * Wiring: call `attachYjsWs(httpServer, isAllowedOrigin)` once at boot
 * — same `httpServer` already used by the main `/ws` server. Both
 * paths coexist because we set `noServer: true` and manually dispatch
 * the upgrade.
 */

import type { Server } from "node:http";
import { WebSocketServer } from "ws";
// y-websocket ships a setupWSConnection util at /bin/utils.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setupWSConnection: any;
try {
    // Dynamic require so the companion still builds if y-websocket
    // isn't installed yet — the feature simply stays dormant.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    setupWSConnection = require("y-websocket/bin/utils").setupWSConnection;
} catch {
    setupWSConnection = null;
}

export function attachYjsWs(httpServer: Server, isAllowedOrigin: (o: string | undefined) => boolean): void {
    if (!setupWSConnection) {
        console.warn("[yjs-ws] y-websocket not installed; skipping companion Yjs bridge.");
        return;
    }
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (conn, req) => {
        // Strip the /yjs/ prefix; the rest is the room name (used by Yjs).
        const url = req.url ?? "/yjs/";
        const roomName = url.replace(/^\/yjs\/?/, "") || "default";
        // setupWSConnection expects (conn, req, { docName, gc }).
        setupWSConnection(conn, req, { docName: roomName, gc: true });
    });

    httpServer.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        if (!url.startsWith("/yjs")) return; // let the main /ws handler take it
        const origin = req.headers.origin as string | undefined;
        if (!isAllowedOrigin(origin)) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    });
}
