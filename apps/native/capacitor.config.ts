import type { CapacitorConfig } from "@capacitor/cli";

// Dev/prod target URL.
//
// Set `CAP_SERVER_URL` before `cap sync android` to point the WebView at
// a local dev server. The Android emulator reaches the host machine at
// 10.0.2.2, so for `pnpm dev` on the host use:
//   CAP_SERVER_URL=http://10.0.2.2:13789
// Physical devices on the same Wi-Fi can use the host's LAN IP, or any
// public tunnel (cloudflared / ngrok).
const SERVER_URL = process.env.CAP_SERVER_URL?.trim() || "https://mixai.ro";
const isHttp = SERVER_URL.startsWith("http://");
let serverHostname = "mixai.ro";
let allowNavigation = ["mixai.ro", "*.mixai.ro"];
try {
    const parsed = new URL(SERVER_URL);
    serverHostname = parsed.hostname;
    // In dev, allow navigation back to the same host so OAuth redirects work.
    allowNavigation = [parsed.hostname];
} catch {
    /* keep production defaults */
}

const config: CapacitorConfig = {
    appId: "ro.mixai.app",
    appName: "MixAI",
    // The "web assets" directory. Capacitor expects something to exist;
    // we point to a minimal index.html that immediately forwards to the
    // remote URL when online and serves the existing PWA shell offline
    // (the mixai.ro service worker registers itself on first visit).
    webDir: "dist",
    server: {
        url: SERVER_URL,
        // Plaintext HTTP only when explicitly targeting a dev URL.
        cleartext: isHttp,
        // Lock the WebView to the configured origin so deep links/redirects
        // outside the app open in the system browser instead of inside the
        // native shell (better UX + safer).
        allowNavigation,
        // Match the configured URL's scheme so cookies / OAuth callbacks
        // behave exactly like the web build at that origin.
        androidScheme: isHttp ? "http" : "https",
        iosScheme: isHttp ? "http" : "https",
        hostname: serverHostname,
    },
    ios: {
        contentInset: "always",
        // Matches the dark `--background` token (oklch(0.13 0.02 285)).
        backgroundColor: "#151320",
        // We let Capacitor handle status-bar styling; the web app reads
        // CSS env(safe-area-inset-*) for notches.
        limitsNavigationsToAppBoundDomains: true,
    },
    android: {
        backgroundColor: "#151320",
        allowMixedContent: false,
        captureInput: true,
        webContentsDebuggingEnabled: false,
        // Android TV / Leanback compatibility is declared in
        // android/app/src/main/AndroidManifest.xml (see ANDROID_TV.md).
        buildOptions: {
            // Block the soft keyboard from auto-showing on TV inputs.
            // The user navigates with a remote; on-screen keyboard would
            // cover the focused element.
            keystorePath: undefined,
        },
    },
};

export default config;
