/**
 * GET /api/lan-url
 *
 * Returns candidate LAN URLs that a phone on the same WiFi can use to reach
 * this dev/prod server. Useful for showing a "Connect from phone" hint without
 * forcing the user to figure out their own IP.
 *
 * Privacy: only enumerates *private* IPv4 ranges (192.168.*, 10.*, 172.16-31.*).
 * Public IPs are filtered out.
 */

import { NextResponse } from "next/server";
import os from "node:os";
import { headers } from "next/headers";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

function isPrivateIPv4(addr: string): boolean {
    if (addr.startsWith("192.168.")) return true;
    if (addr.startsWith("10.")) return true;
    if (addr.startsWith("169.254.")) return true; // link-local
    const m = addr.match(/^172\.(\d+)\./);
    if (m) {
        const second = parseInt(m[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

export async function GET() {
    // Auth required: enumerates the host's private-network IPv4 addresses.
    // While these are RFC1918 ranges (and therefore not directly routable
    // from the internet), the response still discloses the host's exact LAN
    // topology to anyone who can reach the public endpoint \u2014 useful for
    // pivoting once an attacker has any other foothold on the same network,
    // and unnecessary surface for an unauthenticated GET.
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const h = await headers();
    const host = h.get("host") ?? "localhost:13789";
    const port = host.includes(":") ? host.split(":").pop() : "13789";

    const interfaces = os.networkInterfaces();
    const candidates: string[] = [];

    for (const ifaceList of Object.values(interfaces)) {
        if (!ifaceList) continue;
        for (const iface of ifaceList) {
            if (iface.family !== "IPv4" || iface.internal) continue;
            if (!isPrivateIPv4(iface.address)) continue;
            candidates.push(iface.address);
        }
    }

    // Sort 192.168.* first (most common home), then 10.*, then 172.*
    candidates.sort((a, b) => {
        const score = (s: string) => s.startsWith("192.168.") ? 0 : s.startsWith("10.") ? 1 : 2;
        return score(a) - score(b);
    });

    return NextResponse.json({
        urls: candidates.map((ip) => `http://${ip}:${port}/remote`),
        port,
    });
}
