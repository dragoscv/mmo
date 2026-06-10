"use client";

/**
 * RemoteHostBridge — wraps a page to enable remote control hosting.
 * Automatically starts the RemoteSyncEngine and broadcasts state.
 *
 * Usage:
 *   <RemoteHostBridge page="mixer">
 *     <MixerView />
 *   </RemoteHostBridge>
 */

import { type ReactNode } from "react";
import { RemoteProvider } from "./remote-context";
import type { RemotePage } from "@/lib/remote-sync";

export function RemoteHostBridge({ page, children }: { page: RemotePage; children: ReactNode }) {
    return (
        <RemoteProvider page={page}>
            {children}
        </RemoteProvider>
    );
}
