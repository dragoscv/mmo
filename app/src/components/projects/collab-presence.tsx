"use client";

/**
 * Multi-user presence avatars for any project surface (DAW / Editor /
 * Mixer / Live). Mounts a Yjs provider for the given (kind, externalId)
 * and renders the awareness state as a stack of colored avatars.
 *
 * Renders nothing for guests (no userId), or before the provider mounts
 * (SSR-safe). All Yjs imports are dynamic so the bundle stays small on
 * pages that don't use collab.
 */

import { useEffect, useMemo, useState } from "react";
import type { ProjectKind } from "@/db/schema-projects";

interface RemoteUser {
    id: string;
    name: string;
    color: string;
}

interface CollabPresenceProps {
    kind: ProjectKind;
    externalId: string | null;
    userId: string | null;
    displayName: string | null;
    className?: string;
}

export function CollabPresence({
    kind,
    externalId,
    userId,
    displayName,
    className,
}: CollabPresenceProps) {
    const [users, setUsers] = useState<RemoteUser[]>([]);
    const enabled = Boolean(externalId && userId && displayName);

    useEffect(() => {
        if (!enabled || !externalId || !userId || !displayName) return;
        let cancelled = false;
        let handle: { destroy(): void } | null = null;

        (async () => {
            try {
                const mod = await import("@/lib/collab/yjs-provider");
                if (cancelled) return;
                const h = mod.createYjsProvider({
                    kind,
                    externalId,
                    userId,
                    displayName,
                });
                handle = h;
                const sync = () => {
                    const out: RemoteUser[] = [];
                    h.awareness.getStates().forEach((state, clientId) => {
                        if (clientId === h.awareness.clientID) return;
                        const u = (state as Record<string, unknown>).user as RemoteUser | undefined;
                        if (u && typeof u.id === "string") out.push(u);
                    });
                    setUsers(out);
                };
                h.awareness.on("change", sync);
                sync();
            } catch (err) {
                console.warn("[CollabPresence] failed to connect:", err);
            }
        })();

        return () => {
            cancelled = true;
            try { handle?.destroy(); } catch { /* ignore */ }
        };
    }, [enabled, kind, externalId, userId, displayName]);

    const visible = useMemo(() => users.slice(0, 4), [users]);
    const overflow = users.length - visible.length;

    if (!enabled || users.length === 0) return null;

    return (
        <div
            className={`flex items-center -space-x-2 ${className ?? ""}`}
            aria-label={`${users.length} collaborator${users.length === 1 ? "" : "s"} online`}
        >
            {visible.map((u) => (
                <div
                    key={u.id}
                    title={u.name}
                    className="h-6 w-6 rounded-full ring-2 ring-zinc-900 flex items-center justify-center text-[10px] font-semibold text-white"
                    style={{ backgroundColor: u.color }}
                >
                    {u.name.slice(0, 1).toUpperCase()}
                </div>
            ))}
            {overflow > 0 && (
                <div
                    className="h-6 w-6 rounded-full ring-2 ring-zinc-900 flex items-center justify-center text-[10px] font-semibold text-white bg-zinc-700"
                    title={`+${overflow} more`}
                >
                    +{overflow}
                </div>
            )}
        </div>
    );
}
