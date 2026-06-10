"use client";

/**
 * Yjs-backed multi-cursor collaboration provider for project docs.
 *
 * One Y.Doc per (kind, externalId), persisted locally via IndexedDB
 * and fanned out via WebSocket. Room name is `mmo:{kind}:{externalId}`.
 *
 * Default WebSocket target order:
 *   1. opts.wsUrl (caller override)
 *   2. NEXT_PUBLIC_YJS_RELAY_URL  (cloud relay)
 *   3. ws://<host>:5174/ws        (local companion)
 *
 * The cloud relay is a tiny Cloudflare Worker + Durable Object — see
 * `infra/yjs-relay/`. The companion ws server speaks the y-websocket
 * protocol on the "yjs" subprotocol (see `server/src/collab/yjs-ws.ts`).
 */

import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import type { ProjectKind } from "@/db/schema-projects";

export interface YjsProviderHandle {
    doc: Y.Doc;
    awareness: WebsocketProvider["awareness"];
    persistence: IndexeddbPersistence;
    provider: WebsocketProvider;
    destroy(): void;
}

export interface YjsProviderOptions {
    kind: ProjectKind;
    externalId: string;
    userId: string;
    displayName: string;
    color?: string;
    wsUrl?: string;
}

function defaultWsUrl(): string | null {
    const envUrl = process.env.NEXT_PUBLIC_YJS_RELAY_URL;
    if (envUrl) return envUrl;
    // Local companion fallback is opt-in to avoid console spam when it isn't running.
    if (process.env.NEXT_PUBLIC_YJS_RELAY_LOCAL === "1" && typeof window !== "undefined") {
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${scheme}//${window.location.hostname}:5174/ws`;
    }
    return null;
}

const HEX_COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];
function hashColor(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return HEX_COLORS[Math.abs(h) % HEX_COLORS.length];
}

export function createYjsProvider(opts: YjsProviderOptions): YjsProviderHandle {
    const room = `mmo:${opts.kind}:${opts.externalId}`;
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(room, doc);
    const wsUrl = opts.wsUrl ?? defaultWsUrl();
    const provider = new WebsocketProvider(wsUrl ?? "ws://disabled.invalid", room, doc, {
        connect: wsUrl !== null,
        // The companion / cloud relay both accept the "yjs" subprotocol.
        params: { kind: opts.kind, externalId: opts.externalId },
    });
    provider.awareness.setLocalStateField("user", {
        id: opts.userId,
        name: opts.displayName,
        color: opts.color ?? hashColor(opts.userId),
    });
    return {
        doc,
        awareness: provider.awareness,
        persistence,
        provider,
        destroy() {
            try { provider.disconnect(); } catch { /* ignore */ }
            try { provider.destroy(); } catch { /* ignore */ }
            try { persistence.destroy(); } catch { /* ignore */ }
            doc.destroy();
        },
    };
}
