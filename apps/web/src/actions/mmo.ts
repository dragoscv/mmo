"use server";

/**
 * Browser → MMO Server connection for the WP16 media surfaces (profiles, music, Live TV, hub).
 * Same reachability rules and token the player already hands to the browser in HLS `?t=` URLs
 * (`companionHlsUrl`): tunnel HTTPS on hosted runtimes, loopback/LAN when co-located.
 */

import { auth } from "@/auth";
import { getAllCompanionLinks, getCompanionLinkForDevice } from "@/lib/companion-library";

export interface MmoConnection {
    baseUrl: string;
    token: string;
    userId: string;
    deviceId: string;
    name: string;
    online: boolean;
}

export interface MmoConnections {
    servers: MmoConnection[];
    /** Preferred server (first online, else most recently seen). */
    primary: MmoConnection | null;
}

/** All paired servers reachable from this runtime, online first. */
export async function getMmoConnections(): Promise<MmoConnections> {
    const session = await auth();
    if (!session?.user?.id) return { servers: [], primary: null };
    const links = await getAllCompanionLinks().catch(() => []);
    const servers = links.map((l) => ({
        baseUrl: l.apiUrl, token: l.token, userId: l.userId, deviceId: l.deviceId, name: l.name, online: l.online,
    }));
    return { servers, primary: servers[0] ?? null };
}

/** One specific paired server (device id), or null. */
export async function getMmoConnection(deviceId: string): Promise<MmoConnection | null> {
    if (typeof deviceId !== "string" || !/^[\w-]{1,64}$/.test(deviceId)) return null;
    const l = await getCompanionLinkForDevice(deviceId).catch(() => null);
    if (!l) return null;
    return { baseUrl: l.apiUrl, token: l.token, userId: l.userId, deviceId: l.deviceId, name: "", online: true };
}
