"use client";

import type { PartyConnection } from "@/hooks/use-watch-party";

/** Overlay rendered above the seek bar showing each member's cursor as a
 *  small vertical tick with their name. Coordinates `x` are 0..1 of the
 *  full bar width. Hidden when the local user is the only participant. */
export function PartyCursors({ party }: { party: PartyConnection }) {
    if (!party.connected || party.cursors.size === 0) return null;

    const colors = ["#7cc4ff", "#ffb066", "#a3e635", "#f472b6", "#fbbf24", "#67e8f9"];
    let i = 0;

    return (
        <div style={{ position: "absolute", left: 0, right: 0, top: -20, height: 18, pointerEvents: "none" }}>
            {Array.from(party.cursors.values()).map((c) => {
                if (c.memberId === party.youId) return null;
                const color = colors[i++ % colors.length];
                return (
                    <div
                        key={c.memberId}
                        style={{
                            position: "absolute",
                            left: `${Math.max(0, Math.min(100, c.x * 100))}%`,
                            transform: "translateX(-50%)",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                        }}
                    >
                        <div style={{
                            background: color,
                            color: "#000",
                            fontSize: 9,
                            padding: "1px 4px",
                            borderRadius: 3,
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.6)",
                        }}>{c.name}</div>
                        <div style={{ width: 2, height: 12, background: color }} />
                    </div>
                );
            })}
        </div>
    );
}
