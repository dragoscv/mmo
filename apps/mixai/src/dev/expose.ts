/**
 * Development-only: put a value on `window.__decksExt[name]` so a remote debugger can reach a
 * feature's store or helpers (`window.__decks` in ./dev-hooks.ts holds the core ones). A no-op
 * in production builds; safe to call at module scope.
 */
export function devExpose(name: string, value: unknown): void {
    if (!import.meta.env?.DEV || typeof window === "undefined") return;
    const w = window as unknown as { __decksExt?: Record<string, unknown> };
    w.__decksExt = { ...(w.__decksExt ?? {}), [name]: value };
}
