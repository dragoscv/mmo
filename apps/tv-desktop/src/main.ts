/**
 * MixAI TV desktop entry (WP17-25). Installs the desktop transport, then boots the shared TV UI.
 *
 * Transport: every `fetch` to an http(s) URL that is not the app's own origin goes through `@tauri-apps/plugin-http`
 * (Rust client): LAN MixAI Servers on plain http work from the secure app origin, with no CORS or mixed-content
 * limits. hls.js uses its FetchLoader on desktop (see Player), so playlists and segments take the same path.
 * `<video src>` direct play needs neither CORS nor a proxy.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const nativeFetch = globalThis.fetch.bind(globalThis);
const own = location.origin;
// Tauri's own IPC travels as fetch to http://ipc.localhost (Windows/Android) — never reroute it through plugin-http.
const isIpc = (url: string) => /^https?:\/\/ipc\.localhost(\/|$)/i.test(url);

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:\/\//i.test(url) && !url.startsWith(own) && !isIpc(url)) return tauriFetch(input, init);
    return nativeFetch(input, init);
}) as typeof fetch;

await import("../../tv-tizen/src/main.tsx");
