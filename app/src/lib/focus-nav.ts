/**
 * D-pad / remote focus helpers for Android TV and TV-like surfaces.
 *
 * Web-platform-only — relies on standard keyboard arrow events that
 * Android TV remotes emit through the WebView. No vendor SDK required.
 *
 * Usage:
 *   bindArrowKeys(); // attaches a global listener; call once from a layout
 *   focusFirst(rootEl); // focus the first focusable child of a container
 */

const FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type=hidden])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusables(root: ParentNode = document): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
}

export function focusFirst(root: ParentNode = document): boolean {
    const els = focusables(root);
    if (els[0]) {
        els[0].focus();
        els[0].scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
    }
    return false;
}

/**
 * Pick the focusable closest to the current one along a direction.
 * Uses bounding-rect geometry — works well for grid layouts.
 */
function pickNeighbour(current: HTMLElement, dir: "up" | "down" | "left" | "right"): HTMLElement | null {
    const cur = current.getBoundingClientRect();
    const all = focusables().filter((el) => el !== current);
    let best: { el: HTMLElement; dist: number } | null = null;
    for (const el of all) {
        const r = el.getBoundingClientRect();
        const dx = (r.left + r.width / 2) - (cur.left + cur.width / 2);
        const dy = (r.top + r.height / 2) - (cur.top + cur.height / 2);
        const inDir =
            (dir === "up" && dy < -4) ||
            (dir === "down" && dy > 4) ||
            (dir === "left" && dx < -4) ||
            (dir === "right" && dx > 4);
        if (!inDir) continue;
        // Distance penalises off-axis movement so we prefer the same row/column.
        const axisDist = dir === "up" || dir === "down" ? Math.abs(dy) + Math.abs(dx) * 2 : Math.abs(dx) + Math.abs(dy) * 2;
        if (!best || axisDist < best.dist) best = { el, dist: axisDist };
    }
    return best?.el ?? null;
}

let bound = false;
export function bindArrowKeys(): () => void {
    if (typeof window === "undefined") return () => undefined;
    if (bound) return () => undefined;
    bound = true;

    const handler = (e: KeyboardEvent) => {
        const map: Record<string, "up" | "down" | "left" | "right"> = {
            ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
        };
        const dir = map[e.key];
        if (!dir) return;
        const active = (document.activeElement as HTMLElement | null) ?? null;
        // In text inputs, let the arrows behave normally.
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
        const start = active && active !== document.body ? active : focusables()[0];
        if (!start) return;
        const next = pickNeighbour(start, dir);
        if (next) {
            e.preventDefault();
            next.focus();
            next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
        }
    };
    window.addEventListener("keydown", handler);
    return () => {
        window.removeEventListener("keydown", handler);
        bound = false;
    };
}
