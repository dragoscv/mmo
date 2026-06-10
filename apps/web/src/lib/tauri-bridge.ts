/**
 * Tiny shim for invoking Tauri commands from the web shell without
 * pulling in `@tauri-apps/api` (which would bloat the web bundle).
 *
 * Tauri v2 always exposes `window.__TAURI_INTERNALS__.invoke(cmd, args)`
 * inside the desktop webview. We feature-detect at call time so the
 * same code runs in plain browsers as a no-op.
 */

interface TauriInternals {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface TauriGlobal {
    __TAURI_INTERNALS__?: TauriInternals;
}

export function isTauri(): boolean {
    if (typeof window === "undefined") return false;
    return Boolean((window as unknown as TauriGlobal).__TAURI_INTERNALS__);
}

export async function tauriInvoke<T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
): Promise<T | null> {
    if (!isTauri()) return null;
    const t = (window as unknown as TauriGlobal).__TAURI_INTERNALS__;
    if (!t) return null;
    try {
        return (await t.invoke(cmd, args)) as T;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[tauri] invoke '${cmd}' failed`, err);
        return null;
    }
}
