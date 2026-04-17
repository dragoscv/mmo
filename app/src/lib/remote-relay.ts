/**
 * Server-side in-memory relay for remote sync.
 *
 * Peers within the same userId share a channel. Messages posted via
 * `broadcast()` are forwarded to all SSE-connected clients of that user
 * except the sender.
 *
 * Uses `globalThis` to persist across HMR in development.
 */

export interface RelayClient {
    id: string;          // peerId (from the browser)
    userId: string;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    controller: ReadableStreamDefaultController<Uint8Array>;
}

class RemoteRelay {
    private clients = new Map<string, RelayClient>();

    /** Register an SSE client */
    add(client: RelayClient) {
        this.clients.set(client.id, client);
    }

    /** Remove an SSE client */
    remove(id: string) {
        this.clients.delete(id);
    }

    /** Broadcast a message to all clients of the same userId, except sender */
    broadcast(senderId: string, userId: string, data: string) {
        const encoder = new TextEncoder();
        const payload = encoder.encode(`data: ${data}\n\n`);

        for (const client of this.clients.values()) {
            if (client.userId !== userId) continue;
            if (client.id === senderId) continue;
            try {
                client.controller.enqueue(payload);
            } catch {
                // Client disconnected — clean up
                this.clients.delete(client.id);
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
