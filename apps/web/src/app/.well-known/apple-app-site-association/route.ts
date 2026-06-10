import { NextResponse } from "next/server";

// Apple Universal Links — tells iOS that taps on https://muzicai.ro/... can
// open the native MMO app (Capacitor build) instead of Safari when it's
// installed. Apple fetches this file once per app install from the EXACT
// path /.well-known/apple-app-site-association with Content-Type
// application/json.
//
// The `appID` is `<TeamID>.<bundleId>`. Until we have a real Apple Team ID
// the placeholder TEAMID below will simply prevent iOS from honoring the
// universal link — the deep-link otherwise behaves identically to a normal
// https:// navigation, so this is safe to ship now and refine later.
//
// Set NEXT_PUBLIC_APPLE_TEAM_ID in the deployment env to override.

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
    const teamId = process.env.NEXT_PUBLIC_APPLE_TEAM_ID || "TEAMID";
    const bundleId = "ro.muzicai.app";

    const body = {
        applinks: {
            apps: [],
            details: [
                {
                    appID: `${teamId}.${bundleId}`,
                    paths: [
                        // Match every path under https://muzicai.ro/
                        // EXCEPT explicit web-only routes (Auth.js callbacks,
                        // Stripe webhooks, the offline page).
                        "*",
                        "NOT /api/auth/*",
                        "NOT /api/stripe/*",
                        "NOT /api/companion/*",
                        "NOT /offline",
                    ],
                },
            ],
        },
        webcredentials: {
            apps: [`${teamId}.${bundleId}`],
        },
    };

    return NextResponse.json(body, {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
        },
    });
}
