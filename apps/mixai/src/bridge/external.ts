/**
 * Open a web page in the user's default browser (WP19-27).
 *
 * Only URLs of a constant allowlist are accepted: this module is not a general "open anything"
 * door for the webview. Inside the Tauri shell the page is opened by the shell plugin's `open`
 * command (`tauri-plugin-shell` 2.6: `open(path: String, with: Option<Program>)`, permission
 * `shell:allow-open` in capabilities/main.json; the plugin's default scope accepts
 * `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`). The JS package `@tauri-apps/plugin-shell` is
 * not a dependency: the command is invoked through `@tauri-apps/api/core`, like bridge/engine.ts.
 * Outside Tauri (browser preview) it is `window.open(url, "_blank", "noopener")`.
 */
// Relative + explicit extension so `node --test` can load this module without the Vite alias.
import { devExpose } from "../dev/expose.ts";

/** Where a recorded set is uploaded to Mixcloud. */
export const MIXCLOUD_UPLOAD_URL = "https://www.mixcloud.com/upload/";

/** Every URL this app may open in the browser. Exact matches only. */
export const EXTERNAL_URLS: readonly string[] = [MIXCLOUD_UPLOAD_URL];

/** `opened` = handed to the system; `refused` = not on the allowlist; `failed` = the shell or the browser said no. */
export type OpenResult = "opened" | "refused" | "failed";

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface ExternalDeps {
    /** The Tauri `invoke`, or null outside Tauri. Default: found like bridge/engine.ts does. */
    invoke?: InvokeFn | null;
    /** `window.open` of the browser preview. */
    open?: (url: string, target: string, features: string) => unknown;
}

export function isAllowedExternal(url: unknown): url is string {
    return typeof url === "string" && EXTERNAL_URLS.includes(url);
}

let invokeImpl: InvokeFn | null = null;

async function getInvoke(): Promise<InvokeFn | null> {
    if (invokeImpl) return invokeImpl;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        const mod = await import("@tauri-apps/api/core");
        invokeImpl = mod.invoke as InvokeFn;
        return invokeImpl;
    }
    return null;
}

type Opener = (url: string) => Promise<OpenResult>;
let devOpener: Opener | null = null;
// Development only (CDP tests on a dev instance): stand in for the real opener, so a test never
// opens a browser window on the machine. `devExpose` is a no-op in a production build, and
// nothing else can reach `devOpener`.
devExpose("external", {
    stub: (fn: Opener | null) => {
        devOpener = fn;
    },
    /** True while a stand-in is installed (a test checks this right before it presses Upload). */
    stubbed: () => devOpener !== null,
});

/** Open `url` in the default browser. Never throws. */
export async function openExternal(url: string, deps: ExternalDeps = {}): Promise<OpenResult> {
    if (!isAllowedExternal(url)) return "refused";
    try {
        if (devOpener) return await devOpener(url);
        const invoke = deps.invoke === undefined ? await getInvoke() : deps.invoke;
        if (invoke) {
            await invoke<null>("plugin:shell|open", { path: url });
            return "opened";
        }
        const open = deps.open ?? (typeof window !== "undefined" ? window.open.bind(window) : null);
        if (!open) return "failed";
        // With "noopener" the return value is always null: it says nothing about success.
        open(url, "_blank", "noopener");
        return "opened";
    } catch {
        return "failed";
    }
}
