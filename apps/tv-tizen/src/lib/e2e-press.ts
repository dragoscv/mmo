/**
 * Debug-only remote key injection for device verification.
 *
 * Samsung `sdb` cannot inject key events into a running web widget, so a
 * DEBUG build (`VITE_E2E_PRESS_URL=http://<pc>:<port>/press`) polls that
 * URL and replays the returned key names as synthetic `keydown` events on
 * `window`, exactly like the remote would. The endpoint returns
 * `{"keys":["down","enter"]}` and drains its queue on each GET.
 *
 * Compiled out entirely when the env var is unset (production `.wgt`).
 */
import type { TvKey } from "./tv-keys";

const KEY_CODES: Partial<Record<TvKey, { key: string; keyCode: number }>> = {
    up: { key: "ArrowUp", keyCode: 38 },
    down: { key: "ArrowDown", keyCode: 40 },
    left: { key: "ArrowLeft", keyCode: 37 },
    right: { key: "ArrowRight", keyCode: 39 },
    enter: { key: "Enter", keyCode: 13 },
    back: { key: "Escape", keyCode: 10009 },
    play: { key: "MediaPlay", keyCode: 415 },
    pause: { key: "MediaPause", keyCode: 19 },
    playpause: { key: "MediaPlayPause", keyCode: 10252 },
    stop: { key: "MediaStop", keyCode: 413 },
    rewind: { key: "MediaRewind", keyCode: 412 },
    fastforward: { key: "MediaFastForward", keyCode: 417 },
};

function dispatch(k: TvKey): void {
    const spec = KEY_CODES[k];
    if (!spec) return;
    const ev = new KeyboardEvent("keydown", { key: spec.key, bubbles: true, cancelable: true });
    // Tizen key handling reads `keyCode`; KeyboardEventInit ignores it on some engines.
    Object.defineProperty(ev, "keyCode", { get: () => spec.keyCode });
    (document.activeElement ?? window).dispatchEvent(ev);
}

/** Optional command sink for non-key actions (`open:movie:550`). */
let onCommand: ((cmd: string) => void) | null = null;
export function setE2eCommandHandler(h: ((cmd: string) => void) | null): void { onCommand = h; }

export function installE2ePressHook(): void {
    const url = import.meta.env.VITE_E2E_PRESS_URL as string | undefined;
    if (!url) return;
    console.warn("[e2e] remote key hook ENABLED →", url);
    const tick = async () => {
        try {
            const r = await fetch(url, { cache: "no-store" });
            if (!r.ok) return;
            const j = (await r.json()) as { keys?: string[] };
            for (const k of j.keys ?? []) {
                if (k in KEY_CODES) dispatch(k as TvKey);
                else onCommand?.(k);
                await new Promise((res) => setTimeout(res, 250));
            }
        } catch { /* PC offline — keep polling */ }
    };
    window.setInterval(() => { void tick(); }, 500);
    // Screen snapshot the driver can read back (focused element + visible texts).
    window.setInterval(() => {
        void fetch(url.replace(/\/press$/, "/state"), {
            method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
            body: JSON.stringify({
                at: Date.now(),
                focused: (document.activeElement as HTMLElement | null)?.textContent?.trim().slice(0, 120) ?? null,
                buttons: Array.from(document.querySelectorAll<HTMLElement>("button,[data-focusable]")).map((b) => b.textContent?.trim().slice(0, 80)).filter(Boolean).slice(0, 40),
            }),
        }).catch(() => { /* ignore */ });
    }, 1000);
}
