import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "ro.muzicai.app",
    appName: "MMO",
    // The "web assets" directory. Capacitor expects something to exist;
    // we point to a minimal index.html that immediately forwards to the
    // remote URL when online and serves the existing PWA shell offline
    // (the muzicai.ro service worker registers itself on first visit).
    webDir: "dist",
    server: {
        // Production: load the live web app. The Next.js PWA's service
        // worker keeps things working offline after the first visit.
        url: "https://muzicai.ro",
        // We do not allow plaintext HTTP — only the production HTTPS origin.
        cleartext: false,
        // Lock the WebView to the muzicai.ro origin so deep links/redirects
        // outside the app open in the system browser instead of inside the
        // native shell (better UX + safer).
        allowNavigation: ["muzicai.ro", "*.muzicai.ro"],
        // Use the production origin as the document origin (instead of
        // capacitor://localhost) so cookies, OAuth callbacks, and the PWA
        // service worker behave exactly like the web build.
        androidScheme: "https",
        iosScheme: "https",
        hostname: "muzicai.ro",
    },
    ios: {
        contentInset: "always",
        backgroundColor: "#0a0a0a",
        // We let Capacitor handle status-bar styling; the web app reads
        // CSS env(safe-area-inset-*) for notches.
        limitsNavigationsToAppBoundDomains: true,
    },
    android: {
        backgroundColor: "#0a0a0a",
        allowMixedContent: false,
        captureInput: true,
        webContentsDebuggingEnabled: false,
    },
};

export default config;
