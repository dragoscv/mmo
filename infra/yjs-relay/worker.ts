/**
 * Cloudflare Worker + Durable Object — Yjs relay.
 *
 * Each room is a Durable Object instance: it owns one Y.Doc, holds
 * connected WebSockets, and broadcasts y-websocket protocol messages.
 * Snapshots are written to R2 (env.YJS_BUCKET) every ~60s for cold
 * loads / server restarts.
 *
 * Deploy:
 *   pnpm i -g wrangler
 *   wrangler login
 *   cd infra/yjs-relay
 *   wrangler deploy
 *
 * Then set `NEXT_PUBLIC_YJS_RELAY_URL=wss://<worker>.workers.dev` in
 * the web app's env. The web client points y-websocket at that URL and
 * everything else stays unchanged.
 *
 * NOTE: Run `pnpm add yjs y-protocols lib0` inside this folder before
 * deploying — the Worker bundle pulls them in directly.
 */

import * as Y from "yjs";
// y-protocols ships ESM that runs in Workers.
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

interface Env {
    YJS_ROOM: DurableObjectNamespace;
    YJS_BUCKET?: R2Bucket;
}

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);
        // Path = /<roomName>
        const roomName = url.pathname.replace(/^\//, "") || "default";
        const id = env.YJS_ROOM.idFromName(roomName);
        const stub = env.YJS_ROOM.get(id);
        return stub.fetch(req);
    },
};

export class YjsRoom {
    private doc = new Y.Doc();
    private awareness = new awarenessProtocol.Awareness(this.doc);
    private conns = new Set<WebSocket>();
    private state: DurableObjectState;
    private env: Env;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        this.env = env;
        state.blockConcurrencyWhile(async () => {
            // Restore from R2 if available.
            if (env.YJS_BUCKET) {
                const obj = await env.YJS_BUCKET.get(`${state.id.toString()}.bin`);
                if (obj) {
                    const buf = new Uint8Array(await obj.arrayBuffer());
                    Y.applyUpdate(this.doc, buf);
                }
            }
        });
        this.doc.on("update", () => this.scheduleFlush());
    }

    async fetch(req: Request): Promise<Response> {
        const upgrade = req.headers.get("Upgrade");
        if (upgrade !== "websocket") {
            return new Response("expected websocket", { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        this.handleSession(server);
        return new Response(null, { status: 101, webSocket: client });
    }

    private handleSession(ws: WebSocket): void {
        ws.accept();
        this.conns.add(ws);

        // Initial sync step 1.
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        ws.send(encoding.toUint8Array(encoder));

        // Send current awareness state.
        const states = this.awareness.getStates();
        if (states.size > 0) {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(
                enc,
                awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
            );
            ws.send(encoding.toUint8Array(enc));
        }

        ws.addEventListener("message", (ev: MessageEvent) => {
            const data = new Uint8Array(ev.data as ArrayBuffer);
            const decoder = decoding.createDecoder(data);
            const messageType = decoding.readVarUint(decoder);
            const encoder = encoding.createEncoder();
            switch (messageType) {
                case MESSAGE_SYNC:
                    encoding.writeVarUint(encoder, MESSAGE_SYNC);
                    syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
                    if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
                    // Broadcast updates to everyone else.
                    for (const peer of this.conns) {
                        if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(data);
                    }
                    break;
                case MESSAGE_AWARENESS:
                    awarenessProtocol.applyAwarenessUpdate(
                        this.awareness,
                        decoding.readVarUint8Array(decoder),
                        ws,
                    );
                    for (const peer of this.conns) {
                        if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(data);
                    }
                    break;
            }
        });

        ws.addEventListener("close", () => {
            this.conns.delete(ws);
            awarenessProtocol.removeAwarenessStates(
                this.awareness,
                Array.from(this.awareness.getStates().keys()).filter(
                    (id) => id !== this.doc.clientID,
                ),
                ws,
            );
        });
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(async () => {
            this.flushTimer = null;
            if (!this.env.YJS_BUCKET) return;
            const state = Y.encodeStateAsUpdate(this.doc);
            await this.env.YJS_BUCKET.put(`${this.state.id.toString()}.bin`, state);
        }, 60_000);
    }
}
