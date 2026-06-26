"use client";

/**
 * Layout-level keep-alive host for HEAVY routes only (LRU, last 5).
 *
 * App Router unmounts a route's subtree on navigation, so heavy pages (library,
 * analysis, playlists, daw, mixer, editor, live, watch) lose their state +
 * scroll and feel slow to return to. This host keeps the rendered subtree of
 * recently-visited HEAVY routes mounted and just toggles visibility, so going
 * back is instant and in-page state (filters, selection, scroll, audio graphs)
 * is preserved.
 *
 * Scoped (whitelisted) on purpose: only heavy routes are cached. Every other
 * route renders normally (no behavior change), keeping this low-risk — modals,
 * portals, and one-off pages are unaffected.
 *
 * Keyed by the matched route prefix (not full path/query) so `/library?page=2`
 * reuses the single `/library` instance; the page reads the query from the URL
 * and its own state persists across pages.
 */

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

const MAX_ALIVE = 5;

/** Route prefixes whose page subtree should be kept mounted. */
const KEEP_ALIVE_ROUTES = [
    "/library",
    "/analysis",
    "/playlists",
    "/daw",
    "/mixer",
    "/editor",
    "/live",
    "/watch",
] as const;

function matchRoute(pathname: string): string | null {
    let best: string | null = null;
    for (const r of KEEP_ALIVE_ROUTES) {
        if (pathname === r || pathname.startsWith(r + "/")) {
            if (!best || r.length > best.length) best = r;
        }
    }
    return best;
}

interface Entry {
    key: string;
    node: ReactNode;
    lastUsed: number;
}

export function KeepAlive({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const routeKey = matchRoute(pathname);
    const [entries, setEntries] = useState<Entry[]>([]);

    // Capture/refresh the current heavy route's subtree using the React
    // "adjust state during render" pattern (guarded so it doesn't loop).
    if (routeKey) {
        const existing = entries.find((e) => e.key === routeKey);
        if (!existing || existing.node !== children) {
            setEntries((prev) => {
                const now = Date.now();
                const without = prev.filter((e) => e.key !== routeKey);
                const next = [...without, { key: routeKey, node: children, lastUsed: now }];
                next.sort((a, b) => a.lastUsed - b.lastUsed);
                return next.slice(Math.max(0, next.length - MAX_ALIVE));
            });
        }
    }

    return (
        <>
            {entries.map((entry) => {
                const active = entry.key === routeKey;
                return (
                    <div
                        key={entry.key}
                        data-keepalive-route={entry.key}
                        hidden={!active}
                        inert={!active}
                        style={active ? { display: "contents" } : { display: "none" }}
                    >
                        {entry.node}
                    </div>
                );
            })}

            {/* Non-heavy routes render normally (not cached). */}
            {!routeKey && children}
        </>
    );
}
