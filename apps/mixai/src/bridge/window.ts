/**
 * Native window controls for the custom title bar (decorations are off on
 * Windows/Linux; macOS keeps its traffic lights via titleBarStyle Overlay).
 * Every call is a no-op in the plain browser preview.
 */

export type Platform = "windows" | "macos" | "linux" | "browser";

function inTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function platform(): Platform {
    if (!inTauri()) return "browser";
    const ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return "windows";
    if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
    return "linux";
}

async function win() {
    if (!inTauri()) return null;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    if (!inTauri()) return null;
    const { invoke: inv } = await import("@tauri-apps/api/core");
    return inv<T>(cmd, args);
}

export const windowCtl = {
    minimize: async () => (await win())?.minimize(),
    toggleMaximize: async () => (await win())?.toggleMaximize(),
    close: async () => (await win())?.close(),
    startDragging: async () => (await win())?.startDragging(),
    isMaximized: async () => (await (await win())?.isMaximized()) ?? false,
    setFullscreen: async (on: boolean) => (await win())?.setFullscreen(on),
    isFullscreen: async () => (await (await win())?.isFullscreen()) ?? false,
    /** Native minimum so the solver never has to dock an essential panel. */
    setMinSize: async (w: number, h: number) => {
        const cur = await win();
        if (!cur) return;
        const { LogicalSize } = await import("@tauri-apps/api/dpi");
        await cur.setMinSize(new LogicalSize(w, h));
    },
    /** Subscribe to maximize/restore changes (resize events). */
    onResized: async (cb: () => void): Promise<() => void> => {
        const cur = await win();
        if (!cur) return () => {};
        return cur.onResized(cb);
    },
    /** Windows 11 Snap Layouts flyout (hover on maximize). No-op elsewhere. */
    showSnapOverlay: () => invoke<void>("window_show_snap_overlay"),
    /** Open a panel in its own window (second monitor). */
    popOut: (panel: string) => invoke<void>("window_pop_out", { panel }),
};
