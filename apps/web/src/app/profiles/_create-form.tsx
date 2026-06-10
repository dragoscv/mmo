"use client";

import { useState, useTransition } from "react";
import { createProfile } from "@/actions/video";
import { useRouter } from "next/navigation";

export function CreateProfileForm() {
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [color, setColor] = useState("#7c3aed");
    const [isKid, setIsKid] = useState(false);
    const router = useRouter();

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                startTransition(async () => {
                    await createProfile({ name: name.trim(), color, isKid });
                    setName("");
                    router.refresh();
                });
            }}
            style={{ display: "flex", gap: ".75rem", alignItems: "flex-end", flexWrap: "wrap" }}
        >
            <label style={{ display: "flex", flexDirection: "column", fontSize: ".85rem" }}>
                Nume
                <input
                    type="text" value={name} onChange={(e) => setName(e.target.value)}
                    placeholder="Numele profilului" required maxLength={64}
                    style={{ padding: ".5rem .75rem", border: "1px solid #ccc", borderRadius: 6, marginTop: ".25rem", minWidth: 220 }}
                />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: ".85rem" }}>
                Culoare
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                    style={{ width: 60, height: 40, border: "none", marginTop: ".25rem" }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: ".5rem", fontSize: ".85rem" }}>
                <input type="checkbox" checked={isKid} onChange={(e) => setIsKid(e.target.checked)} />
                Mod copii (filtrare 18+)
            </label>
            <button type="submit" disabled={pending}
                style={{ padding: ".6rem 1rem", borderRadius: 6, background: "#7c3aed", color: "#fff", border: "none", fontWeight: 600, cursor: "pointer" }}>
                {pending ? "Se creează…" : "Adaugă"}
            </button>
        </form>
    );
}
