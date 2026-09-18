/**
 * UI strings (RO default, EN). Locale comes from the shared theme prefs blob
 * `mixai:prefs:v1` (same key every MixAI surface reads — see docs/design-system.md §3),
 * so a language picked on the TV survives restarts and prehydrate.js sets `lang`.
 */
export type Locale = "ro" | "en";

export const PREFS_KEY = "mixai:prefs:v1";
export const LOCALE_EVENT = "mixai:locale";

const ro = {
    // Common
    "common.back": "Înapoi",
    "common.retry": "Reîncearcă",
    "common.newCode": "Cod nou",
    "common.loading": "Se încarcă…",
    "common.error": "Eroare: {message}",
    "common.scanQr": "Sau scanează cu telefonul",
    "common.expiresIn": "Expiră în {time}",
    "common.codeExpired": "Codul a expirat. Cere unul nou.",
    "common.search": "Căutare",

    // Welcome
    "welcome.title": "Bun venit la MixAI TV",
    "welcome.sub": "Cum vrei să te conectezi?",
    "welcome.signin.title": "Conectare cu contul MixAI",
    "welcome.signin.sub": "Un cod pe ecran, îl confirmi de pe telefon. Serverele tale apar automat.",
    "welcome.recommended": "Recomandat",
    "welcome.local.title": "Conectare la un server din această rețea",
    "welcome.local.sub": "Caută MMO Server în rețeaua locală și împerechează cu un cod de 6 cifre.",

    // Sign in
    "signin.title": "Conectare cu contul MixAI",
    "signin.sub": "Deschide {host}/activate pe telefon și introdu codul.",
    "signin.requesting": "Se cere un cod de la {host}…",
    "signin.connecting": "Bun venit, {name}! Se caută serverele tale…",
    "signin.user": "utilizator",
    "signin.denied": "Conectarea a fost refuzată de pe telefon.",
    "signin.yourCode": "Codul tău",
    "signin.waiting": "Se așteaptă confirmarea…",
    "signin.errNetwork": "Nu am putut contacta {host} (rețea)",
    "signin.errStatus": "Nu am putut contacta {host} ({status})",
    "signin.errInvalid": "Răspuns invalid de la {host}",

    // Discover
    "discover.title": "MixAI TV",
    "discover.scanning": "Se caută MMO Server în {scope}…",
    "discover.localNetwork": "rețeaua locală",
    "discover.pick": "Alege serverul la care vrei să te conectezi.",
    "discover.none": "Nu am găsit niciun MMO Server pe portul 17899.",
    "discover.savedBefore": "Salvat anterior",
    "discover.uninitialized": "Server neinițializat",
    "discover.spinner": "Se scanează…",
    "discover.again": "Caută din nou",
    "discover.manual": "Introdu adresa manual",

    // Pair
    "pair.title": "Conectare la {name}",
    "pair.requesting": "Se cere un cod…",
    "pair.label": "Introdu acest cod în MMO Server → Quick Connect sau pe mixai.ro/pair",
    "pair.waiting": "Se așteaptă aprobarea…",
    "pair.errNoToken": "Serverul nu este inițializat (fără device token).",
    "pair.errInvalid": "Răspuns invalid la /pair/request",

    // Connect (manual)
    "connect.title": "MixAI TV",
    "connect.sub": "Conectează-te la MMO Server din rețeaua locală.",
    "connect.host": "Server (IP sau host[:port])",
    "connect.token": "Device token (opțional)",
    "connect.tokenPlaceholder": "gol = împerechere cu cod",
    "connect.user": "User ID (opțional)",
    "connect.userPlaceholder": "gol = utilizatorul asociat serverului",
    "connect.submit": "Conectare",
    "connect.submitting": "Se conectează…",
    "connect.quick": "Împerechează cu cod",
    "connect.errHost": "Introdu adresa serverului (ex. 192.168.100.61).",
    "connect.checking": "Se verifică {url} …",
    "connect.errUnreachable": "Serverul nu răspunde la {url}/health. Verifică IP-ul, portul 17899 și firewall-ul.",
    "connect.errToken": "Token invalid (401).",
    "connect.ok": "Conectat.",

    // Home
    "home.title": "MixAI TV",
    "home.movies": "Filme",
    "home.moviesEmpty": "Niciun film. Adaugă un folder Movies în MMO Server → Settings.",
    "home.shows": "Seriale",
    "home.continue": "Continuă vizionarea",
    "home.newAlbums": "Albume noi",
    "home.newAlbumsEmpty": "Nicio piesă în bibliotecă.",
    "home.recent": "Ascultate recent",
    "home.recentEmpty": "Nimic ascultat încă.",
    "home.settings": "Setări",
    "home.changeServer": "Schimbă serverul",
    "home.signOut": "Deconectare din cont",
    "home.language": "Limbă: Română",
    "home.clearProgress": "Șterge progresul",
    "home.episodes": "{n} episoade",
    "home.songs": "{n} piese",

    // Show
    "show.episodes": "{n} episoade",
    "show.empty": "Niciun episod.",

    // Search
    "search.title": "Căutare",
    "search.placeholder": "Titlu film, serial sau album",
    "search.hint": "Apasă OK pe câmp pentru tastatură. Minimum 2 caractere.",
    "search.movies": "Filme",
    "search.shows": "Seriale",
    "search.albums": "Albume",
    "search.none": "Niciun rezultat pentru „{q}”.",

    // Album
    "album.empty": "Album gol.",

    // Player
    "player.play": "▶ Redă",
    "player.pause": "❚❚ Pauză",
    "player.subtitles": "Subtitrare: {track}",
    "player.subOff": "off",
    "player.sub": "Sub {n}",
    "player.next": "Următoarea ⏭",
    "player.hint.seek": "◀ ▶ ±10s · OK / ⏯ pauză",
    "player.hint.subs": "galben = subtitrare",
    "player.hint.queue": "▲ ▼ piesa anterioară / următoarea",
    "player.hint.back": "BACK ieșire",
    "player.errMse": "MSE indisponibil pe acest dispozitiv.",
    "player.errFormat": "Format nesuportat de TV (MEDIA_ERR_SRC_NOT_SUPPORTED).",
    "player.errMedia": "Eroare media ({code}).",
} as const;

export type MessageKey = keyof typeof ro;

const en: Record<MessageKey, string> = {
    "common.back": "Back",
    "common.retry": "Retry",
    "common.newCode": "New code",
    "common.loading": "Loading…",
    "common.error": "Error: {message}",
    "common.scanQr": "Or scan with your phone",
    "common.expiresIn": "Expires in {time}",
    "common.codeExpired": "The code expired. Request a new one.",
    "common.search": "Search",

    "welcome.title": "Welcome to MixAI TV",
    "welcome.sub": "How do you want to connect?",
    "welcome.signin.title": "Sign in with your MixAI account",
    "welcome.signin.sub": "A code on screen, confirm it from your phone. Your servers appear automatically.",
    "welcome.recommended": "Recommended",
    "welcome.local.title": "Connect to a server on this network",
    "welcome.local.sub": "Find MMO Server on the local network and pair with a 6-digit code.",

    "signin.title": "Sign in with your MixAI account",
    "signin.sub": "Open {host}/activate on your phone and enter the code.",
    "signin.requesting": "Requesting a code from {host}…",
    "signin.connecting": "Welcome, {name}! Looking for your servers…",
    "signin.user": "user",
    "signin.denied": "Sign-in was denied from the phone.",
    "signin.yourCode": "Your code",
    "signin.waiting": "Waiting for confirmation…",
    "signin.errNetwork": "Could not reach {host} (network)",
    "signin.errStatus": "Could not reach {host} ({status})",
    "signin.errInvalid": "Invalid response from {host}",

    "discover.title": "MixAI TV",
    "discover.scanning": "Looking for MMO Server on {scope}…",
    "discover.localNetwork": "the local network",
    "discover.pick": "Choose the server to connect to.",
    "discover.none": "No MMO Server found on port 17899.",
    "discover.savedBefore": "Saved before",
    "discover.uninitialized": "Server not initialised",
    "discover.spinner": "Scanning…",
    "discover.again": "Scan again",
    "discover.manual": "Enter the address manually",

    "pair.title": "Connect to {name}",
    "pair.requesting": "Requesting a code…",
    "pair.label": "Enter this code in MMO Server → Quick Connect or on mixai.ro/pair",
    "pair.waiting": "Waiting for approval…",
    "pair.errNoToken": "The server is not initialised (no device token).",
    "pair.errInvalid": "Invalid response from /pair/request",

    "connect.title": "MixAI TV",
    "connect.sub": "Connect to MMO Server on the local network.",
    "connect.host": "Server (IP or host[:port])",
    "connect.token": "Device token (optional)",
    "connect.tokenPlaceholder": "empty = pair with a code",
    "connect.user": "User ID (optional)",
    "connect.userPlaceholder": "empty = the user paired with the server",
    "connect.submit": "Connect",
    "connect.submitting": "Connecting…",
    "connect.quick": "Pair with a code",
    "connect.errHost": "Enter the server address (e.g. 192.168.100.61).",
    "connect.checking": "Checking {url} …",
    "connect.errUnreachable": "The server does not answer at {url}/health. Check the IP, port 17899 and the firewall.",
    "connect.errToken": "Invalid token (401).",
    "connect.ok": "Connected.",

    "home.title": "MixAI TV",
    "home.movies": "Movies",
    "home.moviesEmpty": "No movies. Add a Movies folder in MMO Server → Settings.",
    "home.shows": "TV shows",
    "home.continue": "Continue watching",
    "home.newAlbums": "New albums",
    "home.newAlbumsEmpty": "No tracks in the library.",
    "home.recent": "Recently played",
    "home.recentEmpty": "Nothing played yet.",
    "home.settings": "Settings",
    "home.changeServer": "Change server",
    "home.signOut": "Sign out",
    "home.language": "Language: English",
    "home.clearProgress": "Clear resume data",
    "home.episodes": "{n} episodes",
    "home.songs": "{n} songs",

    "show.episodes": "{n} episodes",
    "show.empty": "No episodes.",

    "search.title": "Search",
    "search.placeholder": "Movie, show or album title",
    "search.hint": "Press OK on the field for the keyboard. Minimum 2 characters.",
    "search.movies": "Movies",
    "search.shows": "TV shows",
    "search.albums": "Albums",
    "search.none": "No results for “{q}”.",

    "album.empty": "Empty album.",

    "player.play": "▶ Play",
    "player.pause": "❚❚ Pause",
    "player.subtitles": "Subtitles: {track}",
    "player.subOff": "off",
    "player.sub": "Sub {n}",
    "player.next": "Next ⏭",
    "player.hint.seek": "◀ ▶ ±10s · OK / ⏯ pause",
    "player.hint.subs": "yellow = subtitles",
    "player.hint.queue": "▲ ▼ previous / next track",
    "player.hint.back": "BACK exit",
    "player.errMse": "MSE unavailable on this device.",
    "player.errFormat": "Format not supported by the TV (MEDIA_ERR_SRC_NOT_SUPPORTED).",
    "player.errMedia": "Media error ({code}).",
};

export const messages: Record<Locale, Record<string, string>> = { ro, en };

function readPrefs(): Record<string, unknown> {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        const j = raw ? (JSON.parse(raw) as unknown) : null;
        return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function getLocale(): Locale {
    const l = readPrefs().locale;
    if (l === "ro" || l === "en") return l;
    try {
        if (typeof navigator !== "undefined" && /^en/i.test(navigator.language ?? "")) return "en";
    } catch { /* ignore */ }
    return "ro";
}

export function setLocale(l: Locale): void {
    try {
        const p = readPrefs();
        p.locale = l;
        localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch { /* storage disabled */ }
    try { document.documentElement.lang = l; } catch { /* SSR-less; ignore */ }
    try { window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: l })); } catch { /* ignore */ }
}

export function t(key: MessageKey, params?: Record<string, string | number | null | undefined>): string {
    const table = messages[getLocale()] ?? ro;
    let s = table[key] ?? ro[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v == null ? "" : String(v));
    }
    return s;
}
