import { NextResponse } from "next/server";

// Android App Links — tells Chrome / Android that taps on
// https://muzicai.ro/* should open the native MMO app (Capacitor) when
// installed, instead of bouncing to the browser. Android verifies the
// linkage by fetching this exact path and matching the embedded SHA-256
// against the APK signing cert.
//
// Multiple fingerprints are common (debug + release, Play App Signing's
// upload cert + the cert Play Console actually signs with). The CSV env
// `NEXT_PUBLIC_ANDROID_CERT_FINGERPRINTS` is parsed here so we can add
// more without redeploying code.
//
// Until a signing keystore is wired up, this file ships with an empty
// fingerprint list, which makes Android *not* honor the deep link
// (taps stay in the browser). That is the safe default: no false
// claims, no broken handoffs.

export const dynamic = "force-static";
export const revalidate = 3600;

function parseFingerprints(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(s));
}

export function GET() {
    const packageName = "ro.muzicai.app";
    const fingerprints = parseFingerprints(
        process.env.NEXT_PUBLIC_ANDROID_CERT_FINGERPRINTS
    );

    const body = [
        {
            relation: [
                "delegate_permission/common.handle_all_urls",
                "delegate_permission/common.get_login_creds",
            ],
            target: {
                namespace: "android_app",
                package_name: packageName,
                sha256_cert_fingerprints: fingerprints,
            },
        },
    ];

    return NextResponse.json(body, {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
        },
    });
}
