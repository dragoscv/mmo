"use client";

import { useState, useTransition } from "react";
import { getTraktAuthUrl, disconnectTrakt } from "@/actions/trakt";

interface Props {
    status: { connected: boolean; expiresAt?: number; syncedAt?: number };
}

export function TraktSection({ status }: Props) {
    const [pending, start] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const connect = () => {
        start(async () => {
            setError(null);
            const r = await getTraktAuthUrl("/watch/settings");
            if (r.url) window.location.assign(r.url);
            else setError(r.error ?? "Failed to start OAuth");
        });
    };
    const disconnect = () => {
        start(async () => { await disconnectTrakt(); window.location.reload(); });
    };

    const lastSync = status.syncedAt ? new Date(status.syncedAt).toLocaleString() : null;

    return (
        <div style={{
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            padding: 16,
            background: "rgba(255,255,255,0.02)",
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 600 }}>Trakt.tv</span>
                <span style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: status.connected ? "rgba(80,200,120,0.2)" : "rgba(200,80,80,0.15)",
                    color: status.connected ? "#7fe0a3" : "#e08080",
                }}>{status.connected ? "Connected" : "Not connected"}</span>
            </div>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", margin: "0 0 12px 0" }}>
                Auto-scrobble every play, pause and stop to your Trakt account.
            </p>
            {lastSync && (
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", margin: "0 0 8px 0" }}>
                    Last sync: {lastSync}
                </p>
            )}
            {error && (
                <p style={{ fontSize: 11, color: "#e08080", margin: "0 0 8px 0" }}>{error}</p>
            )}
            {status.connected ? (
                <button type="button" onClick={disconnect} disabled={pending} style={{
                    background: "rgba(200,80,80,0.2)", border: "1px solid rgba(200,80,80,0.4)",
                    color: "#fff", padding: "6px 14px", borderRadius: 6, fontSize: 12,
                    cursor: pending ? "default" : "pointer",
                }}>{pending ? "Working…" : "Disconnect"}</button>
            ) : (
                <button type="button" onClick={connect} disabled={pending} style={{
                    background: "rgba(80,140,220,0.85)", border: 0,
                    color: "#fff", padding: "6px 14px", borderRadius: 6, fontSize: 12,
                    cursor: pending ? "default" : "pointer",
                }}>{pending ? "Redirecting…" : "Connect Trakt"}</button>
            )}
        </div>
    );
}
