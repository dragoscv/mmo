/**
 * Protocol v1 client over the Tauri WebSocket plugin. The connection is made from Rust, which sends
 * no `Origin` header: the engine refuses browser upgrades whose Origin differs from its host.
 */
import WebSocket, { type Message } from "@tauri-apps/plugin-websocket";
import { parseServer, type ClientMsg, type ServerMsg } from "./protocol";
import { meterBus } from "./meter-bus";

export interface ConnectionEvents {
    onMessage: (m: Exclude<ServerMsg, { type: "meters" }>) => void;
    onOpen: () => void;
    onClose: (willRetry: boolean) => void;
}

const BACKOFF_MS = [250, 500, 1000, 2000, 3000];

export class EngineConnection {
    private ws: WebSocket | null = null;
    private unlisten: (() => void) | null = null;
    private nextId = 1;
    private closed = false;
    private attempt = 0;
    private timer: number | undefined;

    constructor(
        private readonly port: number,
        private readonly token: string,
        private readonly ev: ConnectionEvents,
    ) {}

    start() {
        void this.open();
    }

    private async open() {
        if (this.closed) return;
        try {
            const ws = await WebSocket.connect(`ws://127.0.0.1:${this.port}/ws?t=${this.token}&c=desktop`);
            if (this.closed) {
                void ws.disconnect().catch(() => {});
                return;
            }
            this.ws = ws;
            this.attempt = 0;
            this.unlisten = ws.addListener((m) => this.onFrame(m));
            await ws.send(JSON.stringify({ type: "subscribe", meters: true, meters_hz: 30 }));
            this.ev.onOpen();
        } catch {
            this.retry();
        }
    }

    private onFrame(m: Message) {
        if (m.type === "Close") {
            this.drop();
            this.retry();
            return;
        }
        if (m.type !== "Text") return;
        const msg = parseServer(m.data);
        if (!msg) return;
        if (msg.type === "meters") meterBus.publish(msg);
        else this.ev.onMessage(msg);
    }

    private drop() {
        this.unlisten?.();
        this.unlisten = null;
        this.ws = null;
    }

    private retry() {
        if (this.closed) return;
        const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 3000;
        this.attempt += 1;
        this.ev.onClose(true);
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.open(), delay);
    }

    /** Send a control; returns the id echoed by `ack`/`error`, or null when offline. */
    send(msg: ClientMsg): number | null {
        const ws = this.ws;
        if (!ws) return null;
        const id = this.nextId++;
        ws.send(JSON.stringify({ ...msg, id })).catch(() => {
            this.drop();
            this.retry();
        });
        return id;
    }

    close() {
        this.closed = true;
        window.clearTimeout(this.timer);
        const ws = this.ws;
        this.drop();
        if (ws) void ws.disconnect().catch(() => {});
        meterBus.clear();
        this.ev.onClose(false);
    }
}
