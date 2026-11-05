/**
 * Shared theme/prefs blob `mixai:prefs:v1` (same key on every MixAI surface; prehydrate.js applies it to
 * <html> before first paint). TV-only keys live in the same blob: `navOrder` (rail order + visibility).
 */
export const PREFS_KEY = "mixai:prefs:v1";
export const PREFS_EVENT = "mixai:prefs";

export function readPrefs(): Record<string, unknown> {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        const j = raw ? (JSON.parse(raw) as unknown) : null;
        return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function writePrefs(patch: Record<string, unknown>): void {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
    } catch { /* storage disabled */ }
    try { window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: patch })); } catch { /* ignore */ }
}

// ─── Rail order (`navOrder`) ───────────────────────────────────────────────

export const NAV_IDS = ["home", "search", "movies", "shows", "music", "livetv", "settings"] as const;
export type NavId = (typeof NAV_IDS)[number];

/** Visible rail items in order. Unknown ids are dropped; Settings is always present (never lock the user out). */
export function navOrder(prefs: Record<string, unknown> = readPrefs()): NavId[] {
    const raw = prefs.navOrder;
    const list = Array.isArray(raw) ? raw.filter((x): x is NavId => typeof x === "string" && (NAV_IDS as readonly string[]).includes(x)) : [...NAV_IDS];
    const uniq = list.filter((x, i) => list.indexOf(x) === i);
    if (!uniq.includes("settings")) uniq.push("settings");
    return uniq;
}

export function setNavOrder(ids: NavId[]): void {
    writePrefs({ navOrder: ids });
}

// ─── Motion ────────────────────────────────────────────────────────────────

export type MotionPref = "full" | "reduced";

export function getMotion(): MotionPref {
    return readPrefs().motion === "reduced" ? "reduced" : "full";
}

/** Explicit user choice; applied to <html data-motion> immediately. */
export function setMotion(m: MotionPref): void {
    writePrefs({ motion: m, motionUserSet: true });
    try { document.documentElement.setAttribute("data-motion", m); } catch { /* ignore */ }
}

export function motionReduced(): boolean {
    try { return document.documentElement.getAttribute("data-motion") === "reduced"; } catch { return false; }
}
