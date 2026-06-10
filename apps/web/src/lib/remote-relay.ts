/**
 * Server-side in-memory relay for remote sync.
 *
 * Peers within the same userId share a channel. Messages posted via
 * `broadcast()` are forwarded to all SSE-connected clients of that user
 * except the sender.
 *
 * The internal map is keyed by `${userId}\u0000${peerId}` so a peerId
 * picked by user B cannot evict user A's stream (cross-tenant kick).
 *
 * Uses `globalThis` to persist across HMR in development.
 */

export interface RelayClient {
    id: string;          // peerId (from the browser)
    userId: string;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    controller: ReadableStreamDefaultController<Uint8Array>;
}

function key(userId: string, peerId: string) {
    return `${userId}\u0000${peerId}`;
}

class RemoteRelay {
    private clients = new Map<string, RelayClient>();

    /** Register an SSE client. If the same (userId, peerId) re-registers,
     *  the previous controller is closed so it doesn't leak. */
    add(client: RelayClient) {
        const k = key(client.userId, client.id);
        const prev = this.clients.get(k);
        if (prev) {
            try { prev.controller.close(); } catch { /* already closed */ }
        }
        this.clients.set(k, client);
    }

    /** Remove an SSE client (scoped to its owning user). */
    remove(userId: string, peerId: string) {
        this.clients.delete(key(userId, peerId));
    }

    /** Broadcast a message to all clients of the same userId, except sender */
    broadcast(senderId: string, userId: string, data: string) {
        const encoder = new TextEncoder();
        const payload = encoder.encode(`data: ${data}\n\n`);

        for (const [k, client] of this.clients) {
            if (client.userId !== userId) continue;
            if (client.id === senderId) continue;
            try {
                client.controller.enqueue(payload);
            } catch {
                // Client disconnected — clean up
                this.clients.delete(k);
            }
        }
    }

    /** Get count of connected clients for a user */
    clientCount(userId: string): number {
        let n = 0;
        for (const c of this.clients.values()) {
            if (c.userId === userId) n++;
        }
        return n;
    }
}

// Persist across HMR reloads
const globalKey = "__remote_relay__";
function getRelay(): RemoteRelay {
    const g = globalThis as Record<string, unknown>;
    if (!g[globalKey]) {
        g[globalKey] = new RemoteRelay();
    }
    return g[globalKey] as RemoteRelay;
}

export const relay = getRelay();
