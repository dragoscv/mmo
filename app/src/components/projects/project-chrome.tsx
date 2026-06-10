"use client";

/**
 * ProjectChrome — small toolbar fragment mounted in every surface's
 * header (DAW, Editor, Mixer, Live). Renders:
 *
 *   [👤👤+2]   [📷 Snapshots]
 *
 *  - Presence avatars (Yjs awareness for room mmo:{kind}:{externalId})
 *  - Snapshots button that opens a drawer with StorageTierSelector +
 *    snapshot list + "Snapshot now" + (optional) per-row restore.
 *
 * Pass `onRestore` only for surfaces where the parent context knows how
 * to swap the in-memory state with a snapshot's document.
 */

import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import { getMe, type MeInfo } from "@/actions/me";
import type { ProjectKind } from "@/db/schema-projects";
import { CollabPresence } from "./collab-presence";
import { SnapshotsPanel } from "./snapshots-panel";

interface ProjectChromeProps {
    kind: ProjectKind;
    externalId: string | null;
    getCurrentDocument: () => Record<string, unknown>;
    onRestore?: (document: Record<string, unknown>) => void;
    className?: string;
    /** Tooltip / aria label for the snapshots button. */
    label?: string;
}

export function ProjectChrome({
    kind,
    externalId,
    getCurrentDocument,
    onRestore,
    className,
    label = "Snapshots",
}: ProjectChromeProps) {
    const [me, setMe] = useState<MeInfo | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getMe().then((m) => { if (!cancelled) setMe(m); }).catch(() => {});
        return () => { cancelled = true; };
    }, []);

    if (!externalId) return null;

    return (
        <div className={`flex items-center gap-2 ${className ?? ""}`}>
            <CollabPresence
                kind={kind}
                externalId={externalId}
                userId={me?.id ?? null}
                displayName={me?.name ?? null}
            />
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-white/10 hover:border-white/25 text-white/70 hover:text-white/90 transition-colors"
                title={label}
                aria-label={label}
            >
                <Camera className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
            </button>
            <SnapshotsPanel
                open={open}
                onOpenChange={setOpen}
                kind={kind}
                externalId={externalId}
                getCurrentDocument={getCurrentDocument}
                onRestore={onRestore}
            />
        </div>
    );
}
