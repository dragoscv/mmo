// MixAI Music desktop launcher logic (WP17-43). Pure helpers, unit-tested by launcher.test.mjs (node --test).

export const SIGNED_IN_KEY = "mixai-music:desktop-signed-in";

export const STRINGS = {
    en: {
        loading: "Loading…",
        welcomeTitle: "Welcome to MixAI Music",
        welcomeBody: "Sign in with your MixAI account. We open your default browser, so you can use the session you already have there.",
        signIn: "Sign in with your browser",
        continueSignedIn: "Continue (already signed in)",
        signingTitle: "Sign in",
        signingBody: "Finish signing in in your browser.",
        signingHint: "This window continues by itself once you are signed in.",
        cancel: "Cancel",
        cancelledTitle: "Sign-in cancelled",
        cancelledBody: "Press the button to try again.",
        retry: "Try again",
        failedTitle: "Sign-in failed",
        unknownError: "Unknown error",
        noToken: "No token returned",
        offlineTitle: "You're offline",
        offlineBody: "MixAI Music needs a connection to music.mixai.ro. We retry automatically every few seconds.",
        offlineRetry: "Retry now",
    },
    ro: {
        loading: "Se încarcă…",
        welcomeTitle: "Bine ai venit în MixAI Music",
        welcomeBody: "Autentifică-te cu contul MixAI. Deschidem browserul implicit, ca să folosești sesiunea pe care o ai deja acolo.",
        signIn: "Autentificare în browser",
        continueSignedIn: "Continuă (deja autentificat)",
        signingTitle: "Autentificare",
        signingBody: "Termină autentificarea în browser.",
        signingHint: "Fereastra continuă singură după ce te-ai autentificat.",
        cancel: "Anulează",
        cancelledTitle: "Autentificare anulată",
        cancelledBody: "Apasă butonul pentru a încerca din nou.",
        retry: "Încearcă din nou",
        failedTitle: "Autentificarea a eșuat",
        unknownError: "Eroare necunoscută",
        noToken: "Nu s-a primit niciun token",
        offlineTitle: "Ești offline",
        offlineBody: "MixAI Music are nevoie de conexiune la music.mixai.ro. Reîncercăm singuri la câteva secunde.",
        offlineRetry: "Reîncearcă acum",
    },
};

export function pickLang(prefsRaw, navigatorLanguage) {
    try {
        const p = prefsRaw ? JSON.parse(prefsRaw) : null;
        if (p && (p.locale === "ro" || p.locale === "en")) return p.locale;
    } catch {
        /* corrupt prefs */
    }
    return /^ro\b/i.test(navigatorLanguage || "") ? "ro" : "en";
}

export function translator(lang) {
    const table = STRINGS[lang] ?? STRINGS.en;
    return (k) => table[k] ?? STRINGS.en[k] ?? k;
}

/** Only same-origin absolute paths ("/x", never "//host" or "https:"). */
export function safePath(p) {
    return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") ? p : "/";
}

export function appUrl(base, path) {
    return `${base.replace(/\/+$/, "")}${safePath(path)}`;
}

export function bootstrapUrl(base, token, path) {
    const u = new URL("/api/auth/desktop-bootstrap", base);
    u.searchParams.set("token", token);
    u.searchParams.set("redirect", safePath(path));
    return u.toString();
}

/**
 * What the launcher does on start:
 *  - "offline": the web UI is unreachable → offline screen with auto-retry;
 *  - "signin": the user asked to sign in (web login page → desktop_open_signin → `?signin=1`);
 *  - "continue": a previous launch signed in → straight to the web UI;
 *  - "welcome": first launch → choose sign in / continue.
 */
export function decide({ online, signinRequested, signedInBefore }) {
    if (!online) return "offline";
    if (signinRequested) return "signin";
    return signedInBefore ? "continue" : "welcome";
}

/** Exponential retry for the offline screen: 3 s, 6 s, 12 s … capped at 30 s. */
export function retryDelayMs(attempt) {
    return Math.min(30_000, 3000 * 2 ** Math.max(0, attempt));
}
