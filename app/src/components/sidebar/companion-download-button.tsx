"use client";

/**
 * Sidebar button for downloading the MMO Companion desktop app.
 *
 * Behaviour:
 *  - On mount, tries to probe a running companion at `localhost:17899`.
 *    If reachable → render a green "Companion connected" pill, no download.
 *  - If unreachable → fetch `/api/companion/download?info=1` to get the
 *    correct installer URL+version+size for the user's OS, then show a
 *    "Download Companion" button. Clicking it opens the actual installer
 *    URL in a new tab.
 *  - We probe once per mount (5 s timeout). Probing the loopback is cheap
 *    and instantaneous when there's no listener (browser refuses connection
 *    immediately), so this is safe to do on every navigation.
 *
 * Why two layouts (collapsed vs expanded)? The sidebar collapses to a
 * narrow icon rail; we mirror that by showing only an icon button in
 * collapsed mode, with a tooltip via `title` on the anchor.
 */

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useCompanionStatus } from "@/components/companion/companion-status-provider";
import { CompanionStatusCard } from "./companion-status-card";

interface CompanionInfo {
    os: "win" | "mac" | "linux";
    arch: "x64" | "arm64";
    name: string;
    url: string;
    size: number;
    version: string;
    releaseUrl: string;
}

type Status =
    | { kind: "probing" }
    | { kind: "connected"; apiUrl: string; version: string; platform: string; capabilities: string[] }
    | { kind: "available"; info: CompanionInfo }
    | { kind: "no-release" }
    | { kind: "error"; message: string };

function formatMB(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function osLabel(os: CompanionInfo["os"]): string {
    return os === "win" ? "Windows" : os === "mac" ? "macOS" : "Linux";
}

export function CompanionDownloadButton({ collapsed = false }: { collapsed?: boolean }) {
    const [status, setStatus] = useState<Status>({ kind: "probing" });
    const companion = useCompanionStatus();

    useEffect(() => {
        // Companion is reachable — short-circuit, no need to fetch the
        // download manifest.
        if (companion.status === "online" && companion.apiUrl && companion.beacon) {
            setStatus({
                kind: "connected",
                apiUrl: companion.apiUrl,
                version: companion.beacon.version,
                platform: companion.beacon.platform,
                capabilities: companion.beacon.capabilities,
            });
            return;
        }
        // Still discovering — keep the spinner.
        if (companion.status === "discovering" || companion.status === "unknown") {
            setStatus({ kind: "probing" });
            return;
        }
        // Offline → fetch download metadata for this OS (once per offline
        // transition).
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/api/companion/download?info=1", { cache: "no-store" });
                if (cancelled) return;
                if (res.status === 503) {
                    setStatus({ kind: "no-release" });
                    return;
                }
                if (!res.ok) {
                    setStatus({ kind: "error", message: `HTTP ${res.status}` });
                    return;
                }
                const info = (await res.json()) as CompanionInfo;
                setStatus({ kind: "available", info });
            } catch (err) {
                if (cancelled) return;
                setStatus({
                    kind: "error",
                    message: err instanceof Error ? err.message : "fetch failed",
                });
            }
        })();

        return () => { cancelled = true; };
    }, [companion.status, companion.apiUrl, companion.beacon]);

    // ── COLLAPSED layout: 28×28 icon button only ──────────────────────────
    if (collapsed) {
        if (status.kind === "connected") {
            return (
                <CompanionStatusCard
                    apiUrl={status.apiUrl}
                    version={status.version}
                    platform={status.platform}
                    capabilities={status.capabilities}
                    collapsed
                />
            );
        }
        if (status.kind === "available") {
            return (
                <a
                    href={status.info.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title={`Download Companion ${status.info.version} for ${osLabel(status.info.os)}`}
                >
                    <Download className="h-4 w-4" />
                </a>
            );
        }
        if (status.kind === "probing") {
            return (
                <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40">
                    <Loader2 className="h-4 w-4 animate-spin" />
                </div>
            );
        }
        return null;
    }

    // ── EXPANDED layout ───────────────────────────────────────────────────
    if (status.kind === "probing") {
        return (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking companion…
            </div>
        );
    }

    if (status.kind === "connected") {
        return (
            <CompanionStatusCard
                apiUrl={status.apiUrl}
                version={status.version}
                platform={status.platform}
                capabilities={status.capabilities}
            />
        );
    }

    if (status.kind === "available") {
        const isMac = status.info.os === "mac";
        return (
            <div className="space-y-1">
                <a
                    href={status.info.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 rounded-md border border-sidebar-border bg-sidebar px-2 py-1.5 text-[11px] text-sidebar-foreground hover:bg-muted transition-colors"
                    title={`${status.info.name} (${formatMB(status.info.size)})`}
                >
                    <Download className="h-3.5 w-3.5" />
                    <span className="flex-1 truncate">
                        Download Companion
                        <span className="text-muted-foreground/60"> · {osLabel(status.info.os)}</span>
                    </span>
                    <span className="text-muted-foreground/40">{formatMB(status.info.size)}</span>
                </a>
                {isMac && (
                    // macOS-specific install hint. The build is ad-hoc signed
                    // (no Apple Developer ID), so first-launch shows
                    // "developer cannot be verified". Two paths exist:
                    //   1. Right-click → Open in Finder
                    //   2. Strip quarantine flag via Terminal
                    // We surface both as a tiny inline note.
                    <details className="group rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-300/80">
                        <summary className="cursor-pointer text-[10px] font-medium">
                            macOS install help (unsigned build)
                        </summary>
                        <div className="mt-1.5 space-y-1 leading-relaxed text-amber-200/70">
                            <p>
                                Right-click the app in <code>/Applications</code> → <strong>Open</strong>,
                                then click <strong>Open</strong> on the warning dialog.
                            </p>
                            <p className="text-[9px] text-amber-200/50">
                                Or run this in Terminal:
                            </p>
                            <code className="block break-all rounded bg-black/30 p-1 text-[9px] text-amber-100">
                                xattr -dr com.apple.quarantine &quot;/Applications/MMO Companion.app&quot;
                            </code>
                        </div>
                    </details>
                )}
            </div>
        );
    }

    if (status.kind === "no-release") {
        return (
            <div className="px-2 py-1.5 text-[10px] text-muted-foreground/40">
                Companion build pending…
            </div>
        );
    }

    return null; // silent on errors — don't clutter the sidebar
}
