"use client";

/**
 * Storage tier selector — picks where a project's bytes live:
 *
 *  - "cloud":     Postgres + GCS only.
 *  - "companion": Only on the user's local Companion app (better-sqlite3
 *                 + on-disk asset blob store under userData/project-assets).
 *  - "both":      Mirrored. The autosave hook writes to the cloud and
 *                 the companion sync layer pulls it down into SQLite.
 *
 * The value is persisted per (kind, externalId) in localStorage as a
 * lightweight client-side preference; the actual storage decision is
 * enforced by the cloud + companion sync APIs reading the `storage_tier`
 * column on the project row (set via the autosave `extras` channel).
 */

import { useEffect, useState } from "react";

export type StorageTier = "cloud" | "companion" | "both";

const KEY = (kind: string, externalId: string) => `mmo:storage-tier:${kind}:${externalId}`;

export function readStorageTier(kind: string, externalId: string): StorageTier {
    if (typeof window === "undefined") return "cloud";
    const v = localStorage.getItem(KEY(kind, externalId));
    if (v === "cloud" || v === "companion" || v === "both") return v;
    return "cloud";
}

export function writeStorageTier(kind: string, externalId: string, tier: StorageTier): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(KEY(kind, externalId), tier);
}

interface StorageTierSelectorProps {
    kind: string;
    externalId: string;
    onChange?: (tier: StorageTier) => void;
    className?: string;
}

export function StorageTierSelector({ kind, externalId, onChange, className }: StorageTierSelectorProps) {
    const [tier, setTier] = useState<StorageTier>("cloud");

    useEffect(() => {
        setTier(readStorageTier(kind, externalId));
    }, [kind, externalId]);

    const pick = (next: StorageTier) => {
        setTier(next);
        writeStorageTier(kind, externalId, next);
        onChange?.(next);
    };

    const options: Array<{ value: StorageTier; label: string; hint: string }> = [
        { value: "cloud", label: "Cloud", hint: "Postgres + GCS. Works on any device." },
        { value: "companion", label: "Companion only", hint: "Local to this machine. Maximum privacy." },
        { value: "both", label: "Mirror", hint: "Cloud + Companion. Best of both, uses more storage." },
    ];

    return (
        <div className={`flex flex-col gap-2 ${className ?? ""}`}>
            <span className="text-xs uppercase tracking-wide text-white/50">Storage</span>
            <div className="flex flex-col gap-1.5">
                {options.map((opt) => (
                    <label
                        key={opt.value}
                        className={`flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                            tier === opt.value
                                ? "border-blue-500/60 bg-blue-500/10"
                                : "border-white/10 hover:border-white/20"
                        }`}
                    >
                        <input
                            type="radio"
                            name={`storage-tier-${kind}-${externalId}`}
                            checked={tier === opt.value}
                            onChange={() => pick(opt.value)}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col">
                            <span className="text-sm text-white/90">{opt.label}</span>
                            <span className="text-xs text-white/50">{opt.hint}</span>
                        </span>
                    </label>
                ))}
            </div>
        </div>
    );
}
