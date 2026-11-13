/**
 * Typed wrappers around the gig-lock commands (`gig_*` in `src-tauri/src/gig.rs`) and its
 * `gig://close-request` event. Outside Tauri every call resolves to `null`; on a shell that
 * lacks a command the promise rejects with "not allowed. Command not found" and the caller
 * sorts that out (`shellFailure` in gig/gig-core.ts).
 *
 * The close confirmation is decided by the SHELL (it knows the lock through `gig_set_locked`):
 * while locked it holds a close request of the main window back and emits the event. The
 * webview does not listen to Tauri's own `tauri://close-requested`: a listener registered
 * for it survives a page reload inside Tauri (its entry is removed only when the window is
 * destroyed), and from then on the shell would refuse every close with nobody left to answer.
 */

/** Mirror of `GigShell` in `src-tauri/src/gig.rs` (serde camelCase). */
export interface GigShell {
    /** The shell's copy of the lock (drives keep-awake and the close confirmation). */
    locked: boolean;
    /** Keep-awake request: on / off / unsupported (not Windows) / failed (the OS refused). */
    keepAwake: "on" | "off" | "unsupported" | "failed";
}

/** Mirror of `PowerStatus` in `src-tauri/src/gig.rs`. */
export interface PowerStatus {
    source: "mains" | "battery" | "unknown";
    /** 0..100 when known. */
    percent: number | null;
    charging: boolean | null;
}

/** Mirror of `DiskStatus` in `src-tauri/src/gig.rs`. */
export interface DiskStatus {
    /** The folder that was measured. */
    path: string | null;
    freeBytes: number | null;
    totalBytes: number | null;
    /** A network location: its free space is not asked for (a dead share would block). */
    network: boolean;
    /** Why there are no numbers, or null. */
    error: string | null;
}

/** Mirror of `GigSystemStatus` in `src-tauri/src/gig.rs`. */
export interface GigSystemStatus {
    power: PowerStatus;
    disk: DiskStatus;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type UnlistenFn = () => void;

let invokeImpl: InvokeFn | null = null;

function inTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getInvoke(): Promise<InvokeFn | null> {
    if (invokeImpl) return invokeImpl;
    if (!inTauri()) return null;
    const mod = await import("@tauri-apps/api/core");
    invokeImpl = mod.invoke as InvokeFn;
    return invokeImpl;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    return invoke<T>(cmd, args);
}

export const gig = {
    /** The shell's lock state and keep-awake. */
    status: () => call<GigShell>("gig_status"),
    /** Lock / unlock in the shell: keep-awake is requested while locked and released on unlock (idempotent), and a close of the main window asks first. */
    setLocked: (locked: boolean) => call<GigShell>("gig_set_locked", { locked }),
    /** Power source and the free space of the volume holding `path` (null = the shell's default folder). */
    systemStatus: (path: string | null) => call<GigSystemStatus>("gig_system_status", { path }),
    /** Tell the shell the close question is on screen (without it a second close request closes: a dead page must not trap the window). */
    closeSeen: () => call<null>("gig_close_seen"),
    /** Close the calling window for real (no question). */
    closeWindow: () => call<null>("gig_close_window"),
};

/** `gig://close-request`: the shell held a close of the main window back (the lock is on). No-op outside Tauri. */
export async function subscribeCloseRequest(onRequest: () => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<unknown>("gig://close-request", () => onRequest());
}
