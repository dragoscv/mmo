"use client";

/**
 * Yjs-backed multi-cursor collaboration provider for project docs.
 *
 * STATUS: scaffold. Not wired up.
 *
 * Design:
 *   - One Y.Doc per (projectKind, externalId). Stored locally with
 *     `y-indexeddb` for instant load and offline edits.
 *   - Real-time fanout via `y-websocket` pointed at the companion's
 *     existing `/ws` channel (new subprotocol "yjs"), OR a cloud relay
 *     deployed as a separate WebSocket service (Vercel Edge Functions
 *     don't yet support long-lived WS — would need Cloudflare Workers
 *     with Durable Objects, Fly.io, or a small Node service on GCP).
 *   - Cloud Postgres still holds the authoritative `document` JSONB
 *     (snapshot of the Y.Doc state taken every N seconds or on idle).
 *     `yjs_state` BYTEA columns on each project table store the binary
 *     Y.Doc state for cold loads on devices that don't have IndexedDB
 *     yet (or fresh installs).
 *
 * TODO:
 *   1. `pnpm add yjs y-indexeddb y-websocket y-protocols`
 *   2. Decide WebSocket relay target (companion vs cloud) — see
 *      askQuestions follow-up.
 *   3. Wrap the DAW project state object as a shared Y.Map so granular
 *      edits propagate without re-serializing the whole document.
 *   4. Add awareness (cursor positions, selections) per user.
 */

import type { ProjectKind } from "@/db/schema-projects";

export interface YjsProviderHandle {
    /** Disconnect and tear down the provider. */
    destroy(): void;
    /** Y.Doc instance — caller binds it to shared types. */
    doc: unknown;
    /** Awareness instance for presence + cursors. */
    awareness: unknown;
}

export interface YjsProviderOptions {
    kind: ProjectKind;
    externalId: string;
    userId: string;
    displayName: string;
    /** Override the default WebSocket URL (e.g. ws://localhost:5174/ws). */
    wsUrl?: string;
}

export function createYjsProvider(_opts: YjsProviderOptions): YjsProviderHandle {
    throw new Error("createYjsProvider: not implemented (scaffold)");
}
