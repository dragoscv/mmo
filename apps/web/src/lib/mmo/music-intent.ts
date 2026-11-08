/**
 * One-shot playback intents in music URLs (WP17-43/45): the desktop shell and `mixai-music://` links open
 *   /media/music?mix=1                      → start a mix (random 50)
 *   /media/music?play=tr_1,tr_2&index=1     → play these tracks from index
 *   /media/music/search?q=x&play=1          → play the search results
 * Clients consume the intent once and strip the params (router.replace).
 */
export type MusicIntent =
    | { kind: "mix" }
    | { kind: "play"; ids: string[]; index: number }
    | { kind: "playSearch"; q: string };

const ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function parseMusicIntent(path: string, params: URLSearchParams | null | undefined): MusicIntent | null {
    if (!params) return null;
    const play = params.get("play");
    if (path.endsWith("/search")) {
        const q = params.get("q")?.trim() ?? "";
        return play === "1" ? (q ? { kind: "playSearch", q } : { kind: "mix" }) : null;
    }
    if (play) {
        const ids = play.split(",").map((s) => s.trim()).filter((s) => ID.test(s)).slice(0, 200);
        if (ids.length > 0) {
            const raw = Number.parseInt(params.get("index") ?? "0", 10);
            const index = Number.isFinite(raw) ? Math.max(0, Math.min(ids.length - 1, raw)) : 0;
            return { kind: "play", ids, index };
        }
    }
    return params.get("mix") === "1" ? { kind: "mix" } : null;
}

/** Same params without the intent keys (so a reload does not replay it). */
export function withoutIntent(params: URLSearchParams): string {
    const next = new URLSearchParams(params.toString());
    for (const k of ["mix", "play", "index"]) next.delete(k);
    return next.toString();
}
