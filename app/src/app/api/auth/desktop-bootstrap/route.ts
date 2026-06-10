import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { devices, sessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashDeviceToken } from "@/lib/device-token";

// Desktop-shell sign-in bootstrap.
//
// Used by the Tauri shell after the user completes the companion-style
// browser OAuth flow: the local Rust HTTP listener captures the device
// token, then the webview navigates here to exchange that token for a
// real NextAuth session cookie (so the user is signed in to muzicai.ro
// inside the embedded WebView, not just on the device-token API surface).
//
// Security:
//   - Device token must already exist in `devices` (minted seconds ago
//     by /api/devices/auto-register at the end of /api/companion-auth).
//   - We do not extend the token's authority — anyone holding it can
//     already act as the user via the device API. Minting a web session
//     for the same user is therefore not an escalation, just a different
//     credential form.
//   - The token is consumed from the query string and never echoed back;
//     `Referrer-Policy: no-referrer` keeps it from leaking onward.
//   - Hard-fail if no `userId` resolves — never set a session for a
//     mismatched / nonexistent user.

const SESSION_DAYS = 30;

export async function GET(request: NextRequest) {
    const token = request.nextUrl.searchParams.get("token") ?? "";
    const redirectTo = request.nextUrl.searchParams.get("redirect") || "/";

    if (!token || token.length < 16) {
        return NextResponse.json({ error: "missing or invalid token" }, { status: 400 });
    }

    const hash = hashDeviceToken(token);
    const [device] = await db
        .select({ userId: devices.userId })
        .from(devices)
        .where(eq(devices.tokenHash, hash))
        .limit(1);

    if (!device?.userId) {
        return NextResponse.json({ error: "unknown device" }, { status: 401 });
    }

    const sessionToken = randomUUID();
    const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await db.insert(sessions).values({
        sessionToken,
        userId: device.userId,
        expires,
    });

    // Final redirect target: only same-origin paths to avoid open-redirect.
    const safeRedirect = redirectTo.startsWith("/") && !redirectTo.startsWith("//")
        ? redirectTo
        : "/";
    const dest = new URL(safeRedirect, request.nextUrl.origin);

    const response = NextResponse.redirect(dest, { status: 303 });
    const secure = request.nextUrl.protocol === "https:";
    const cookieName = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
    response.cookies.set({
        name: cookieName,
        value: sessionToken,
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        expires,
    });
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    return response;
}
