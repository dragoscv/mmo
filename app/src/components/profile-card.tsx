"use client";

import { useTransition } from "react";
import { setActiveProfileAction } from "@/actions/active-profile";
import { useRouter } from "next/navigation";

export function ProfileCard({ id, name, color, isKid, active }: {
    id: number; name: string; color: string | null; isKid: boolean; active: boolean;
}) {
    const [pending, start] = useTransition();
    const router = useRouter();
    return (
        <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => {
                await setActiveProfileAction(id);
                router.refresh();
            })}
            style={{
                padding: "1.5rem 1rem",
                background: color ?? "#7c3aed",
                borderRadius: 12,
                color: "#fff",
                textAlign: "center",
                boxShadow: active ? "0 0 0 3px var(--watch-accent, #ff3366), 0 4px 12px rgba(0,0,0,.2)" : "0 4px 12px rgba(0,0,0,.2)",
                border: "none",
                cursor: pending ? "wait" : "pointer",
                transition: "transform 120ms",
                transform: active ? "scale(1.04)" : "scale(1)",
            }}
            aria-pressed={active}
        >
            <div style={{ fontSize: "2.5rem", marginBottom: ".5rem" }}>{isKid ? "🧒" : "👤"}</div>
            <div style={{ fontWeight: 600 }}>{name}</div>
            {isKid && <div style={{ fontSize: ".75rem", opacity: .8 }}>Kid Mode</div>}
            {active && <div style={{ fontSize: ".7rem", marginTop: ".4rem", opacity: .9 }}>activ</div>}
        </button>
    );
}
