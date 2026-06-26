"use client";

/**
 * Layout-level keep-alive for HEAVY routes using React 19.2 `<Activity>`.
 *
 * Why Activity (not manual hidden divs): Activity is the React primitive for
 * "keep this mounted but inactive". In `hidden` mode it unmounts effects and
 * DEFERS updates (so background routes don't cost main-thread work), then
 * restores state + effects when it becomes `visible` again. Our earlier manual
 * `hidden`/`display:none` host fought the reconciler and aborted App Router RSC
 * navigations; Activity is designed to coexist with concurrent rendering.
 *
 * Scope: only whitelisted heavy routes are cached (LRU, last 5). Every other
 * route renders normally via `children`, so modals/portals/one-off pages are
 * unaffected. Keyed by route PREFIX so `/library?page=2` reuses the single
 * `/library` instance.
 */

import { Activity, useState, type ReactNode } from "react";
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
            {entries.map((entry) => (
                <Activity
                    key={entry.key}
                    mode={entry.key === routeKey ? "visible" : "hidden"}
                >
                    <div data-keepalive-route={entry.key}>{entry.node}</div>
                </Activity>
            ))}

            {/* Non-heavy routes render normally (not cached). */}
            {!routeKey && children}
        </>
    );
}
