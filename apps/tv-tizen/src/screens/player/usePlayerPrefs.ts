/**
 * Active profile's playback prefs for the Player, available synchronously at mount:
 *  - with `ctx`: `ctx.profiles.active.prefs`;
 *  - always mirrored to localStorage `mixai-tv:player-prefs` = `{profileId, prefs}` (Settings writes it too),
 *    so the first frame already knows the preferred audio/subtitle language;
 *  - without `ctx` (older App wiring): the mirror, then a background `GET /media/profiles` refresh.
 */
import { useEffect, useState } from "react";
import type { ServerHttp } from "../../lib/http";
import type { MediaClient } from "../../lib/media";
import type { Profile } from "../../lib/media-types";
import { PROFILE_KEY } from "../../lib/profiles";
import type { ScreenCtx } from "../../nav/ctx";
import { DEFAULT_PREFS, readPlayerPrefs, type PlayerPrefs } from "./prefs";

export const PLAYER_PREFS_KEY = "mixai-tv:player-prefs";

function storedProfileId(): string | null {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        const j = raw ? (JSON.parse(raw) as { id?: unknown }) : null;
        return j && typeof j.id === "string" ? j.id : null;
    } catch {
        return null;
    }
}

export function mirrorPlayerPrefs(p: Profile | null): void {
    try {
        if (!p) return;
        localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify({ profileId: p.id, prefs: p.prefs ?? {} }));
    } catch { /* storage disabled */ }
}

function readMirror(profileId: string | null): PlayerPrefs | null {
    try {
        const raw = localStorage.getItem(PLAYER_PREFS_KEY);
        const j = raw ? (JSON.parse(raw) as { profileId?: string; prefs?: Record<string, unknown> }) : null;
        if (!j || (profileId && j.profileId !== profileId)) return null;
        return readPlayerPrefs({ prefs: j.prefs ?? {} } as Profile);
    } catch {
        return null;
    }
}

export function usePlayerPrefs(ctx: ScreenCtx | null, media: MediaClient | null, http: ServerHttp): PlayerPrefs {
    const [prefs, setPrefs] = useState<PlayerPrefs>(() => {
        const active = ctx?.profiles.active ?? null;
        if (active) { mirrorPlayerPrefs(active); return readPlayerPrefs(active); }
        return readMirror(ctx?.profiles.profileId ?? storedProfileId()) ?? DEFAULT_PREFS;
    });
    useEffect(() => {
        if (ctx?.profiles.active) return;
        const id = media?.profile ?? storedProfileId();
        if (!id) return;
        let alive = true;
        http.get<{ profiles: Profile[] }>("/media/profiles", { allow404: true })
            .then((r) => {
                const p = r?.profiles.find((x) => x.id === id) ?? null;
                if (!alive || !p) return;
                mirrorPlayerPrefs(p);
                setPrefs(readPlayerPrefs(p));
            })
            .catch(() => undefined);
        return () => { alive = false; };
    }, [ctx, media, http]);
    return prefs;
}
